import { ipcMain, systemPreferences, BrowserWindow, desktopCapturer } from 'electron';
import * as path from 'path';

const SAMPLE_RATE = 16000;
const NUM_CHANNELS = 1;
const BIT_DEPTH = 16;

let mainWindow: BrowserWindow | null = null;
let audioChunks: Int16Array[] = [];
let isRecording = false;

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

function int16ArrayToBuffer(array: Int16Array): Buffer {
  const buffer = Buffer.alloc(array.byteLength);
  for (let i = 0; i < array.length; i++) {
    buffer.writeInt16LE(array[i], i * 2);
  }
  return buffer;
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

ipcMain.on('audio-data', (_event, samples: number[]) => {
  if (isRecording) {
    const int16Array = new Int16Array(samples);
    audioChunks.push(int16Array);
  }
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
          const source = audioContext.createMediaStreamSource(stream);
          
          // Store references for cleanup
          window.__audioStream = stream;
          window.__audioContext = audioContext;
          
          await audioContext.audioWorklet.addModule(
            URL.createObjectURL(new Blob([\`
              class AudioProcessor extends AudioWorkletProcessor {
                constructor() {
                  super();
                  this.samples = [];
                }
                
                process(inputs, outputs, parameters) {
                  const input = inputs[0];
                  if (input.length > 0) {
                    const channelData = input[0];
                    // Convert float32 to int16
                    const int16Samples = new Int16Array(channelData.length);
                    for (let i = 0; i < channelData.length; i++) {
                      int16Samples[i] = Math.max(-32768, Math.min(32767, Math.floor(channelData[i] * 32768)));
                    }
                    this.port.postMessage({ samples: Array.from(int16Samples) });
                  }
                  return true;
                }
              }
              registerProcessor('audio-processor', AudioProcessor);
            \`], { type: 'application/javascript' }))
          );
          
          const processor = new AudioWorkletNode(audioContext, 'audio-processor');
          processor.port.onmessage = (event) => {
            if (event.data.samples) {
              window.assistant?.sendAudioData?.(event.data.samples);
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
      return { success: false, error: result.error || 'Failed to start audio capture' };
    }
    
    return { success: true };
  } catch (error) {
    isRecording = false;
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error starting recording' };
  }
}

export async function stopRecording(): Promise<Buffer> {
  isRecording = false;
  
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      await mainWindow.webContents.executeJavaScript(`
        (function() {
          try {
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
  
  await new Promise(resolve => setTimeout(resolve, 100));
  
  const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const combinedData = new Int16Array(totalLength);
  let offset = 0;
  for (const chunk of audioChunks) {
    combinedData.set(chunk, offset);
    offset += chunk.length;
  }
  
  audioChunks = [];
  
  const audioBuffer = int16ArrayToBuffer(combinedData);
  const wavHeader = createWavHeader(audioBuffer.length);
  
  return Buffer.concat([wavHeader, audioBuffer]);
}

export function isCurrentlyRecording(): boolean {
  return isRecording;
}

export async function cleanupAudioCapture(): Promise<void> {
  isRecording = false;
  audioChunks = [];
  
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
        })()
      `);
    } catch {
      // Window might be destroyed
    }
  }
}