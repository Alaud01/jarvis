import { ipcMain, systemPreferences, BrowserWindow, type MessagePortMain } from 'electron';

const SAMPLE_RATE = 16000;
const NUM_CHANNELS = 1;
const BIT_DEPTH = 16;
const AUDIO_STOP_DRAIN_MS = 150;

let mainWindow: BrowserWindow | null = null;
let audioChunks: Buffer[] = [];
let audioByteLength = 0;
let audioSampleCount = 0;
let audioSumSquares = 0;
let audioPeakAbs = 0;
let audioPort: MessagePortMain | null = null;
let isRecording = false;

export type RecordedAudio = {
  chunks: readonly Buffer[];
  byteLength: number;
  filename: string;
  contentType: string;
  durationMs: number;
  peak: number;
  rms: number;
};

function createWavHeader(dataLength: number): Buffer {
  const header = Buffer.alloc(44);
  const fileSize = dataLength + 36;
  
  header.write('RIFF', 0);
  header.writeUInt32LE(fileSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(NUM_CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * NUM_CHANNELS * (BIT_DEPTH / 8), 28);
  header.writeUInt16LE(NUM_CHANNELS * (BIT_DEPTH / 8), 32);
  header.writeUInt16LE(BIT_DEPTH, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  
  return header;
}

export async function requestMicrophoneAccess(): Promise<boolean> {
  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status !== 'granted') {
      const granted = await systemPreferences.askForMediaAccess('microphone');
      return granted;
    }
    return true;
  }
  return true;
}

export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win;
}

export async function initAudioCapture(): Promise<void> {
  // Audio capture is initialized when needed
}

function closeAudioPort(): void {
  if (audioPort) {
    audioPort.close();
    audioPort = null;
  }
}

function storeAudioChunk(chunk: unknown): void {
  if (isRecording) {
    let buffer: Buffer | null = null;
    if (chunk instanceof ArrayBuffer) {
      buffer = Buffer.from(chunk);
    } else if (ArrayBuffer.isView(chunk)) {
      buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }

    if (buffer) {
      audioChunks.push(buffer);
      audioByteLength += buffer.byteLength;
      for (let offset = 0; offset + 1 < buffer.byteLength; offset += 2) {
        const sample = buffer.readInt16LE(offset) / 32768;
        const absSample = Math.abs(sample);
        audioPeakAbs = Math.max(audioPeakAbs, absSample);
        audioSumSquares += sample * sample;
        audioSampleCount += 1;
      }
    }
  }
}

ipcMain.on('audio-port', (event) => {
  const [port] = event.ports;
  if (!port) {
    return;
  }

  closeAudioPort();
  audioPort = port;

  port.on('message', (messageEvent) => {
    storeAudioChunk(messageEvent.data);
  });
  port.on('close', () => {
    if (audioPort === port) {
      audioPort = null;
    }
  });
  port.start();
});

ipcMain.on('audio-data', (_event, chunk: ArrayBuffer | ArrayBufferView) => {
  storeAudioChunk(chunk);
});

export async function startRecording(): Promise<{ success: boolean; error?: string }> {
  const hasAccess = await requestMicrophoneAccess();
  if (!hasAccess) {
    return { success: false, error: 'Microphone access denied. Please grant permission in System Preferences.' };
  }
  
  if (!mainWindow) {
    return { success: false, error: 'Main window not available' };
  }
  
  audioChunks = [];
  audioByteLength = 0;
  audioSampleCount = 0;
  audioSumSquares = 0;
  audioPeakAbs = 0;
  closeAudioPort();
  isRecording = true;
  
  try {
    // Request microphone access from the renderer
    const result = await mainWindow.webContents.executeJavaScript(`
      (async function() {
        try {
          if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            return { success: false, error: 'getUserMedia not available in this context' };
          }
          
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              sampleRate: ${SAMPLE_RATE},
              channelCount: ${NUM_CHANNELS},
              echoCancellation: true,
              noiseSuppression: true,
            }
          });
          
          const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: ${SAMPLE_RATE} });
          if (audioContext.state === 'suspended') {
            await audioContext.resume();
          }
          const source = audioContext.createMediaStreamSource(stream);
          
          // Store references for cleanup
          window.__audioStream = stream;
          window.__audioContext = audioContext;
          
          await audioContext.audioWorklet.addModule(
            URL.createObjectURL(new Blob([\`
              class AudioProcessor extends AudioWorkletProcessor {
                constructor() {
                  super();
                }
                
                process(inputs, outputs, parameters) {
                  const input = inputs[0];
                  if (input.length > 0) {
                    const channelData = input[0];
                    const pcmBuffer = new ArrayBuffer(channelData.length * 2);
                    const pcmSamples = new DataView(pcmBuffer);
                    for (let i = 0; i < channelData.length; i++) {
                      const sample = Math.max(-32768, Math.min(32767, Math.floor(channelData[i] * 32768)));
                      pcmSamples.setInt16(i * 2, sample, true);
                    }
                    this.port.postMessage(pcmBuffer, [pcmBuffer]);
                  }
                  return true;
                }
              }
              registerProcessor('audio-processor', AudioProcessor);
            \`], { type: 'application/javascript' }))
          );
          
          const processor = new AudioWorkletNode(audioContext, 'audio-processor');
          let audioPort = null;
          try {
            if (typeof MessageChannel !== 'undefined' && window.assistant?.connectAudioPort) {
              const channel = new MessageChannel();
              window.assistant.connectAudioPort(channel.port1);
              audioPort = channel.port2;
              audioPort.start?.();
              window.__audioPort = audioPort;
            }
          } catch {
            audioPort = null;
          }

          processor.port.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
              if (audioPort) {
                audioPort.postMessage(event.data, [event.data]);
              } else {
                window.assistant?.sendAudioData?.(event.data);
              }
            }
          };
          
          source.connect(processor);
          processor.connect(audioContext.destination);
          
          window.__audioProcessor = processor;
          window.__audioSource = source;
          
          return { success: true };
        } catch (error) {
          return { success: false, error: error.message };
        }
      })()
    `);
    
    if (!result.success) {
      isRecording = false;
      audioChunks = [];
      audioByteLength = 0;
      audioSampleCount = 0;
      audioSumSquares = 0;
      audioPeakAbs = 0;
      closeAudioPort();
      return { success: false, error: result.error || 'Failed to start audio capture' };
    }
    
    return { success: true };
  } catch (error) {
    isRecording = false;
    audioChunks = [];
    audioByteLength = 0;
    audioSampleCount = 0;
    audioSumSquares = 0;
    audioPeakAbs = 0;
    closeAudioPort();
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error starting recording' };
  }
}

export async function stopRecording(): Promise<RecordedAudio> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      await mainWindow.webContents.executeJavaScript(`
        (function() {
          try {
            if (window.__audioProcessor) {
              window.__audioProcessor.disconnect();
            }
            if (window.__audioSource) {
              window.__audioSource.disconnect();
            }
            if (window.__audioStream) {
              window.__audioStream.getTracks().forEach(track => track.stop());
              window.__audioStream = null;
            }
            if (window.__audioContext) {
              window.__audioContext.close();
              window.__audioContext = null;
            }
            window.__audioProcessor = null;
            window.__audioSource = null;
          } catch (e) {
            console.error('Error stopping audio:', e);
          }
        })()
      `);
    } catch {
      // Window might be destroyed
    }
  }
  
  await new Promise(resolve => setTimeout(resolve, AUDIO_STOP_DRAIN_MS));
  isRecording = false;

  const wavHeader = createWavHeader(audioByteLength);
  const wavChunks = [wavHeader, ...audioChunks];
  const byteLength = wavHeader.byteLength + audioByteLength;
  const durationMs = audioSampleCount > 0 ? (audioSampleCount / SAMPLE_RATE) * 1000 : 0;
  const rms = audioSampleCount > 0 ? Math.sqrt(audioSumSquares / audioSampleCount) : 0;

  console.log('[AudioRecorder] Captured audio:', {
    bytes: audioByteLength,
    durationMs: Math.round(durationMs),
    peak: Number(audioPeakAbs.toFixed(4)),
    rms: Number(rms.toFixed(4)),
  });

  audioChunks = [];
  audioByteLength = 0;
  audioSampleCount = 0;
  audioSumSquares = 0;
  const peak = audioPeakAbs;
  closeAudioPort();
  audioPeakAbs = 0;

  return {
    chunks: wavChunks,
    byteLength,
    filename: 'audio.wav',
    contentType: 'audio/wav',
    durationMs,
    peak,
    rms,
  };
}

export function isCurrentlyRecording(): boolean {
  return isRecording;
}

export async function cleanupAudioCapture(): Promise<void> {
  isRecording = false;
  audioChunks = [];
  audioByteLength = 0;
  audioSampleCount = 0;
  audioSumSquares = 0;
  audioPeakAbs = 0;
  closeAudioPort();
  
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      await mainWindow.webContents.executeJavaScript(`
        (function() {
          if (window.__audioStream) {
            window.__audioStream.getTracks().forEach(track => track.stop());
          }
          if (window.__audioContext) {
            window.__audioContext.close();
          }
          if (window.__audioPort) {
            window.__audioPort.close();
            window.__audioPort = null;
          }
        })()
      `);
    } catch {
      // Window might be destroyed
    }
  }
}
