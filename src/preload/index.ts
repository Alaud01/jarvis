import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { SearchSourcesEvent } from '../shared/search';
import type { CompactionEvent, StreamChunkEvent, StreamErrorEvent, StreamEventContext, StopStreamRequest } from '../shared/stream';
import type { AttachmentSelectionResult } from '../shared/attachments';
import type { LocalVoiceModelInstallResult, LocalVoiceModelStatus } from '../shared/voiceSetup';
import type {
  CreateDictionaryEntryInput,
  CreateReplacementRuleInput,
  UpdateDictionaryEntryInput,
  UpdateReplacementRuleInput,
  UpdateVocabularyCandidateInput,
} from '../shared/dictionary';

type TransferableMessagePort = NonNullable<Parameters<typeof ipcRenderer.postMessage>[2]>[number];

type VoiceTranscriptPayload = {
  text: string;
  autoSubmit: boolean;
  newChat: boolean;
};

type ChatMessagePayload = {
  role: 'user' | 'assistant';
  content: string;
  images?: string[];
  imageMimeTypes?: string[];
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
  pickAttachmentPaths: (): Promise<string[]> => ipcRenderer.invoke('pick-attachment-paths'),
  readAttachments: (filePaths: string[]): Promise<AttachmentSelectionResult> =>
    ipcRenderer.invoke('read-attachments', filePaths),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
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
  onCompaction: (callback: (event: CompactionEvent) => void) => {
    const listener = (_event: unknown, payload: CompactionEvent) => callback(payload);
    ipcRenderer.on('context-compaction', listener);
    return () => ipcRenderer.removeListener('context-compaction', listener);
  },
  onSearchSources: (callback: (event: SearchSourcesEvent) => void) => {
    const listener = (_event: IpcRendererEvent, event: SearchSourcesEvent) => callback(event);
    ipcRenderer.on('search-sources-event', listener);
    return () => ipcRenderer.removeListener('search-sources-event', listener);
  },
  startVoiceRecording: () => ipcRenderer.invoke('start-voice-recording'),
  stopVoiceRecording: () => ipcRenderer.invoke('stop-voice-recording'),
  getVoiceRecordingState: () => ipcRenderer.invoke('voice-recording-state'),
  getLocalVoiceModelStatus: (): Promise<LocalVoiceModelStatus> => ipcRenderer.invoke('voice-model:status'),
  installLocalVoiceModel: (): Promise<LocalVoiceModelInstallResult> => ipcRenderer.invoke('voice-model:install'),
  onVoiceFlowState: (callback: (state: 'idle' | 'recording' | 'processing') => void) => {
    const listener = (_event: IpcRendererEvent, state: 'idle' | 'recording' | 'processing') => callback(state);
    ipcRenderer.on('voice-flow-state', listener);
    return () => ipcRenderer.removeListener('voice-flow-state', listener);
  },
  onVoiceTranscript: (callback: (payload: VoiceTranscriptPayload) => void) => {
    const listener = (_event: IpcRendererEvent, payload: VoiceTranscriptPayload) => callback(payload);
    ipcRenderer.on('voice-transcript', listener);
    return () => ipcRenderer.removeListener('voice-transcript', listener);
  },
  onVoiceError: (callback: (error: string) => void) => {
    const listener = (_event: IpcRendererEvent, error: string) => callback(error);
    ipcRenderer.on('voice-error', listener);
    return () => ipcRenderer.removeListener('voice-error', listener);
  },
  onMenuNewConversation: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('menu:new-conversation', listener);
    return () => ipcRenderer.removeListener('menu:new-conversation', listener);
  },
  onModelsRefresh: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('menu:models-refresh', listener);
    return () => ipcRenderer.removeListener('menu:models-refresh', listener);
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
  storeLoadOpenTabIds: () => ipcRenderer.invoke('store:load-open-tab-ids'),
  storeSaveOpenTabIds: (tabIds: string[]) => ipcRenderer.invoke('store:save-open-tab-ids', tabIds),
  storeLoadCurrentConversationId: () => ipcRenderer.invoke('store:load-current-conversation-id'),
  storeSaveCurrentConversationId: (id: string | null) => ipcRenderer.invoke('store:save-current-conversation-id', id),
  storeLoadWorkspaceView: () => ipcRenderer.invoke('store:load-workspace-view'),
  storeSaveWorkspaceView: (view: string) => ipcRenderer.invoke('store:save-workspace-view', view),
  storeLoadScrollPositions: () => ipcRenderer.invoke('store:load-scroll-positions'),
  storeSaveScrollPositions: (positions: Record<string, number>) => ipcRenderer.invoke('store:save-scroll-positions', positions),
  storeLoadConversationDrafts: () => ipcRenderer.invoke('store:load-conversation-drafts'),
  storeSaveConversationDrafts: (drafts: Record<string, string>) => ipcRenderer.invoke('store:save-conversation-drafts', drafts),
  dictionaryList: () => ipcRenderer.invoke('dictionary:list'),
  dictionaryCreate: (input: CreateDictionaryEntryInput) => ipcRenderer.invoke('dictionary:create', input),
  dictionaryUpdate: (id: string, input: UpdateDictionaryEntryInput) => ipcRenderer.invoke('dictionary:update', id, input),
  dictionaryDelete: (id: string) => ipcRenderer.invoke('dictionary:delete', id),
  dictionaryRuleCreate: (input: CreateReplacementRuleInput) => ipcRenderer.invoke('dictionary:rule-create', input),
  dictionaryRuleUpdate: (id: string, input: UpdateReplacementRuleInput) => ipcRenderer.invoke('dictionary:rule-update', id, input),
  dictionaryRuleDelete: (id: string) => ipcRenderer.invoke('dictionary:rule-delete', id),
  dictionaryCandidateUpdate: (id: string, input: UpdateVocabularyCandidateInput) =>
    ipcRenderer.invoke('dictionary:candidate-update', id, input),
  usageDashboard: (query: { range: 'hour' | 'day' | 'week' | 'month'; tokenMode?: 'total' | 'input' | 'output' }) =>
    ipcRenderer.invoke('usage:dashboard', query),
  generateTitle: (message: string, model: string, provider: string) => ipcRenderer.invoke('generate-title', message, model, provider),
  setThemeBackground: (isDark: boolean) => ipcRenderer.send('set-theme-background', isDark),
});
