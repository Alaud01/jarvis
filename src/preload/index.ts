import { contextBridge, ipcRenderer } from 'electron';
import type { BrowserLLMTrace, BrowserScreenshotArtifact } from '../shared/browser';

type VoiceTranscriptPayload = {
  text: string;
  autoSubmit: boolean;
  newChat: boolean;
};

type ChatMessagePayload = {
  role: 'user' | 'assistant';
  content: string;
};

type SendMessageStreamRequest = {
  conversationId: string;
  assistantMessageId: string;
  model: string;
  messages: ChatMessagePayload[];
};

type BrowserToolEventPayload = {
  conversationId: string;
  assistantMessageId: string;
  runId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  instruction: string;
  startUrl?: string;
  summary?: string;
  currentUrl?: string;
  pageTitle?: string;
  actionsTaken?: number;
  error?: string;
  processing?: string;
  model?: string;
  mode?: 'dom' | 'hybrid' | 'cua';
  screenshots?: BrowserScreenshotArtifact[];
  llmTrace?: BrowserLLMTrace;
  startedAt: string;
  finishedAt?: string;
  textOffset?: number;
};

contextBridge.exposeInMainWorld('assistant', {
  getModels: () => ipcRenderer.invoke('get-models'),
  sendMessage: (model: string, messages: { role: string; content: string }[]) => 
    ipcRenderer.invoke('send-message', model, messages),
  sendMessageStream: (request: SendMessageStreamRequest) =>
    ipcRenderer.invoke('send-message-stream', request),
  stopStream: () => ipcRenderer.invoke('stop-stream'),
  getVoiceShortcut: () => ipcRenderer.invoke('voice-shortcut-label'),
  onChunk: (callback: (chunk: string) => void) => {
    const listener = (_event: any, chunk: string) => callback(chunk);
    ipcRenderer.on('ollama-chunk', listener);
    return () => ipcRenderer.removeListener('ollama-chunk', listener);
  },
  onDone: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('ollama-done', listener);
    return () => ipcRenderer.removeListener('ollama-done', listener);
  },
  onError: (callback: (error: string) => void) => {
    const listener = (_event: any, error: string) => callback(error);
    ipcRenderer.on('ollama-error', listener);
    return () => ipcRenderer.removeListener('ollama-error', listener);
  },
  onBrowserToolEvent: (callback: (payload: BrowserToolEventPayload) => void) => {
    const listener = (_event: any, payload: BrowserToolEventPayload) => callback(payload);
    ipcRenderer.on('browser-tool-event', listener);
    return () => ipcRenderer.removeListener('browser-tool-event', listener);
  },
  getBrowserArtifactDataUrl: (filePath: string) => ipcRenderer.invoke('browser-artifact:data-url', filePath),
  startVoiceRecording: () => ipcRenderer.invoke('start-voice-recording'),
  stopVoiceRecording: () => ipcRenderer.invoke('stop-voice-recording'),
  getVoiceRecordingState: () => ipcRenderer.invoke('voice-recording-state'),
  onVoiceFlowState: (callback: (state: 'idle' | 'recording' | 'processing') => void) => {
    const listener = (_event: any, state: 'idle' | 'recording' | 'processing') => callback(state);
    ipcRenderer.on('voice-flow-state', listener);
    return () => ipcRenderer.removeListener('voice-flow-state', listener);
  },
  onVoiceTranscript: (callback: (payload: VoiceTranscriptPayload) => void) => {
    const listener = (_event: any, payload: VoiceTranscriptPayload) => callback(payload);
    ipcRenderer.on('voice-transcript', listener);
    return () => ipcRenderer.removeListener('voice-transcript', listener);
  },
  onVoiceError: (callback: (error: string) => void) => {
    const listener = (_event: any, error: string) => callback(error);
    ipcRenderer.on('voice-error', listener);
    return () => ipcRenderer.removeListener('voice-error', listener);
  },
  sendAudioData: (samples: number[]) => ipcRenderer.send('audio-data', samples),
  storeLoadConversations: () => ipcRenderer.invoke('store:load-conversations'),
  storeSaveConversations: (conversations: unknown) => ipcRenderer.invoke('store:save-conversations', conversations),
  storeDeleteConversation: (id: string) => ipcRenderer.invoke('store:delete-conversation', id),
  storeLoadModel: () => ipcRenderer.invoke('store:load-model'),
  storeSaveModel: (model: string) => ipcRenderer.invoke('store:save-model', model),
});