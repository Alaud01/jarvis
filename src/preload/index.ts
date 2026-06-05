import { contextBridge, ipcRenderer } from 'electron';
import type { BrowserTraceEvent } from '../shared/browser';
import type { SearchSourcesEvent } from '../shared/search';
import type { StreamChunkEvent, StreamErrorEvent, StreamEventContext, StopStreamRequest } from '../shared/stream';
import type { AttachmentSelectionResult } from '../shared/attachments';

type TransferableMessagePort = NonNullable<Parameters<typeof ipcRenderer.postMessage>[2]>[number];

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
  pickAttachments: (): Promise<AttachmentSelectionResult> => ipcRenderer.invoke('pick-attachments'),
  sendMessageStream: (request: SendMessageStreamRequest) =>
    ipcRenderer.invoke('send-message-stream', request),
  stopStream: (request: StopStreamRequest) => ipcRenderer.invoke('stop-stream', request),
  getVoiceShortcut: () => ipcRenderer.invoke('voice-shortcut-label'),
  onChunk: (callback: (event: StreamChunkEvent) => void) => {
    const listener = (_event: unknown, payload: StreamChunkEvent) => callback(payload);
    ipcRenderer.on('ollama-chunk', listener);
    return () => ipcRenderer.removeListener('ollama-chunk', listener);
  },
  onDone: (callback: (event: StreamEventContext) => void) => {
    const listener = (_event: unknown, payload: StreamEventContext) => callback(payload);
    ipcRenderer.on('ollama-done', listener);
    return () => ipcRenderer.removeListener('ollama-done', listener);
  },
  onError: (callback: (event: StreamErrorEvent) => void) => {
    const listener = (_event: unknown, payload: StreamErrorEvent) => callback(payload);
    ipcRenderer.on('ollama-error', listener);
    return () => ipcRenderer.removeListener('ollama-error', listener);
  },
  onBrowserTraceEvent: (callback: (event: BrowserTraceEvent) => void) => {
    const listener = (_event: any, event: BrowserTraceEvent) => callback(event);
    ipcRenderer.on('browser-trace-event', listener);
    return () => ipcRenderer.removeListener('browser-trace-event', listener);
  },
  onSearchSources: (callback: (event: SearchSourcesEvent) => void) => {
    const listener = (_event: any, event: SearchSourcesEvent) => callback(event);
    ipcRenderer.on('search-sources-event', listener);
    return () => ipcRenderer.removeListener('search-sources-event', listener);
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
  connectAudioPort: (port: TransferableMessagePort) => ipcRenderer.postMessage('audio-port', null, [port]),
  sendAudioData: (chunk: ArrayBuffer | ArrayBufferView) => ipcRenderer.send('audio-data', chunk),
  storeLoadConversations: () => ipcRenderer.invoke('store:load-conversations'),
  storeLoadConversationList: () => ipcRenderer.invoke('store:load-conversation-list'),
  storeLoadConversation: (id: string) => ipcRenderer.invoke('store:load-conversation', id),
  storeLoadConversationsById: (ids: string[]) => ipcRenderer.invoke('store:load-conversations-by-id', ids),
  storeSaveConversations: (conversations: unknown) => ipcRenderer.invoke('store:save-conversations', conversations),
  storeSaveConversationList: (conversations: unknown) => ipcRenderer.invoke('store:save-conversation-list', conversations),
  storeSaveConversation: (conversation: unknown) => ipcRenderer.invoke('store:save-conversation', conversation),
  storeDeleteConversation: (id: string) => ipcRenderer.invoke('store:delete-conversation', id),
  storeLoadFolders: () => ipcRenderer.invoke('store:load-folders'),
  storeSaveFolders: (folders: unknown) => ipcRenderer.invoke('store:save-folders', folders),
  storeDeleteFolder: (id: string) => ipcRenderer.invoke('store:delete-folder', id),
  storeLoadModel: () => ipcRenderer.invoke('store:load-model'),
  storeSaveModel: (model: string) => ipcRenderer.invoke('store:save-model', model),
  storeLoadProvider: () => ipcRenderer.invoke('store:load-provider'),
  storeSaveProvider: (provider: string) => ipcRenderer.invoke('store:save-provider', provider),
  storeLoadOpenCodeGoApiKey: () => ipcRenderer.invoke('store:load-opencode-go-api-key'),
  storeSaveOpenCodeGoApiKey: (key: string) => ipcRenderer.invoke('store:save-opencode-go-api-key', key),
  storeLoadOpenRouterApiKey: () => ipcRenderer.invoke('store:load-openrouter-api-key'),
  storeSaveOpenRouterApiKey: (key: string) => ipcRenderer.invoke('store:save-openrouter-api-key', key),
  storeLoadOpenTabIds: () => ipcRenderer.invoke('store:load-open-tab-ids'),
  storeSaveOpenTabIds: (tabIds: string[]) => ipcRenderer.invoke('store:save-open-tab-ids', tabIds),
  storeLoadCurrentConversationId: () => ipcRenderer.invoke('store:load-current-conversation-id'),
  storeSaveCurrentConversationId: (id: string | null) => ipcRenderer.invoke('store:save-current-conversation-id', id),
  generateTitle: (message: string, model: string, provider: string) => ipcRenderer.invoke('generate-title', message, model, provider),
  setThemeBackground: (isDark: boolean) => ipcRenderer.send('set-theme-background', isDark),
});
