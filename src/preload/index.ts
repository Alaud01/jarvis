import { contextBridge, ipcRenderer } from 'electron';

type VoiceTranscriptPayload = {
  text: string;
  autoSubmit: boolean;
  newChat: boolean;
};

type ChatMessagePayload = {
  role: 'user' | 'assistant';
  content: string;
};

type ModelInfo = {
  id: string;
  name: string;
  provider: string;
};

type ProviderInfo = {
  id: string;
  name: string;
  available: boolean;
};

type SendMessageStreamRequest = {
  conversationId: string;
  assistantMessageId: string;
  model: string;
  provider: string;
  messages: ChatMessagePayload[];
};

contextBridge.exposeInMainWorld('assistant', {
  getModels: () => ipcRenderer.invoke('get-models'),
  getModelsForProvider: (providerId: string) => ipcRenderer.invoke('get-models-for-provider', providerId),
  getProviders: () => ipcRenderer.invoke('get-providers'),
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
  storeLoadFolders: () => ipcRenderer.invoke('store:load-folders'),
  storeSaveFolders: (folders: unknown) => ipcRenderer.invoke('store:save-folders', folders),
  storeDeleteFolder: (id: string) => ipcRenderer.invoke('store:delete-folder', id),
  storeLoadModel: () => ipcRenderer.invoke('store:load-model'),
  storeSaveModel: (model: string) => ipcRenderer.invoke('store:save-model', model),
  storeLoadProvider: () => ipcRenderer.invoke('store:load-provider'),
  storeSaveProvider: (provider: string) => ipcRenderer.invoke('store:save-provider', provider),
  setThemeBackground: (isDark: boolean) => ipcRenderer.send('set-theme-background', isDark),
});