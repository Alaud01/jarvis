import type { SearchSourceGroup, SearchSourcesEvent } from '../shared/search';
import type { CompactionEvent, StreamChunkEvent, StreamErrorEvent, StreamEventContext, StopStreamRequest } from '../shared/stream';
import type { AttachmentSelectionResult, FileAttachment } from '../shared/attachments';
import type { LocalVoiceModelInstallResult, LocalVoiceModelStatus } from '../shared/voiceSetup';
import type {
  CreateDictionaryEntryInput,
  CreateReplacementRuleInput,
  PersonalDictionaryState,
  UpdateDictionaryEntryInput,
  UpdateReplacementRuleInput,
  UpdateVocabularyCandidateInput,
} from '../shared/dictionary';
import type { UsageDashboardData, UsageDashboardQuery } from '../shared/usage';

export interface Message {
  id: string;
  text: string;
  sender: 'user' | 'assistant';
  timestamp: Date;
  isStreaming?: boolean;
  searchSources?: SearchSourceGroup[];
  attachments?: FileAttachment[];
  compactions?: CompactionActivity[];
}

export interface CompactionActivity {
  id: string;
  status: 'in_progress' | 'completed' | 'failed';
  startedAt: Date;
  completedAt?: Date;
}

export interface Conversation {
  id: string;
  title: string;
  timestamp: Date;
  messages: Message[];
  folderId: string | null;
  isLoaded: boolean;
}

export interface Folder {
  id: string;
  name: string;
  timestamp: Date;
}

export interface SerializedMessage {
  id: string;
  text: string;
  sender: 'user' | 'assistant';
  timestamp: string;
  searchSources?: SearchSourceGroup[];
  attachments?: FileAttachment[];
  compactions?: SerializedCompactionActivity[];
}

export interface SerializedCompactionActivity {
  id: string;
  status: 'in_progress' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
}

export interface SerializedConversation {
  id: string;
  title: string;
  timestamp: string;
  messages: SerializedMessage[];
  folderId: string | null;
}

export interface SerializedConversationMetadata {
  id: string;
  title: string;
  timestamp: string;
  folderId: string | null;
}

export interface SerializedFolder {
  id: string;
  name: string;
  timestamp: string;
}

export type SerializedConversationDrafts = Record<string, string>;

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextLength?: number;
}

export interface ProviderInfo {
  id: string;
  name: string;
  available: boolean;
}

export interface SendMessageStreamRequest {
  conversationId: string;
  assistantMessageId: string;
  model: string;
  provider: string;
  messages: {
    role: 'user' | 'assistant';
    content: string;
    images?: string[];
    imageMimeTypes?: string[];
  }[];
}

export interface VoiceTranscriptPayload {
  text: string;
  autoSubmit: boolean;
  newChat: boolean;
}

export interface PendingVoiceTranscript extends VoiceTranscriptPayload {
  id: string;
}

declare global {
  interface Window {
    assistant: {
      getModels: () => Promise<ModelInfo[]>;
      getModelsForProvider: (providerId: string) => Promise<ModelInfo[]>;
      getProviders: () => Promise<ProviderInfo[]>;
      pickAttachmentPaths: () => Promise<string[]>;
      readAttachments: (filePaths: string[]) => Promise<AttachmentSelectionResult>;
      getPathForFile: (file: File) => string;
      sendMessageStream: (request: SendMessageStreamRequest) => Promise<{ success: boolean; aborted?: boolean }>;
      stopStream: (request: StopStreamRequest) => Promise<{ success: boolean }>;
      getVoiceShortcut: () => Promise<string>;
      onChunk: (callback: (event: StreamChunkEvent) => void) => () => void;
      onDone: (callback: (event: StreamEventContext) => void) => () => void;
      onError: (callback: (event: StreamErrorEvent) => void) => () => void;
      onCompaction: (callback: (event: CompactionEvent) => void) => () => void;
      onSearchSources: (callback: (event: SearchSourcesEvent) => void) => () => void;
      startVoiceRecording: () => Promise<{ success: boolean; error?: string }>;
      stopVoiceRecording: () => Promise<{ success: boolean; error?: string }>;
      getVoiceRecordingState: () => Promise<'idle' | 'recording' | 'processing'>;
      getLocalVoiceModelStatus: () => Promise<LocalVoiceModelStatus>;
      installLocalVoiceModel: () => Promise<LocalVoiceModelInstallResult>;
      onVoiceFlowState: (callback: (state: 'idle' | 'recording' | 'processing') => void) => () => void;
      onVoiceTranscript: (callback: (payload: VoiceTranscriptPayload) => void) => () => void;
      onVoiceError: (callback: (error: string) => void) => () => void;
      onMenuNewConversation: (callback: () => void) => () => void;
      onModelsRefresh: (callback: () => void) => () => void;
      connectAudioPort: (port: MessagePort) => void;
      sendAudioData: (chunk: ArrayBuffer | ArrayBufferView) => void;
      storeLoadConversations: () => Promise<SerializedConversation[]>;
      storeLoadConversationList: () => Promise<SerializedConversationMetadata[]>;
      storeLoadConversation: (id: string) => Promise<SerializedConversation | null>;
      storeLoadConversationsById: (ids: string[]) => Promise<SerializedConversation[]>;
      storeSaveConversations: (conversations: SerializedConversation[]) => Promise<{ success: boolean }>;
      storeSaveConversationList: (conversations: SerializedConversationMetadata[]) => Promise<{ success: boolean }>;
      storeSaveConversation: (conversation: SerializedConversation) => Promise<{ success: boolean }>;
      storeDeleteConversation: (id: string) => Promise<{ success: boolean }>;
      storeLoadFolders: () => Promise<SerializedFolder[]>;
      storeSaveFolders: (folders: SerializedFolder[]) => Promise<{ success: boolean }>;
      storeDeleteFolder: (id: string) => Promise<{ success: boolean }>;
      storeLoadModel: () => Promise<string>;
      storeSaveModel: (model: string) => Promise<{ success: boolean }>;
      storeLoadProvider: () => Promise<string>;
      storeSaveProvider: (provider: string) => Promise<{ success: boolean }>;
      storeLoadOpenTabIds: () => Promise<string[]>;
      storeSaveOpenTabIds: (tabIds: string[]) => Promise<{ success: boolean }>;
      storeLoadCurrentConversationId: () => Promise<string | null>;
      storeSaveCurrentConversationId: (id: string | null) => Promise<{ success: boolean }>;
      storeLoadConversationDrafts: () => Promise<SerializedConversationDrafts>;
      storeSaveConversationDrafts: (drafts: SerializedConversationDrafts) => Promise<{ success: boolean }>;
      dictionaryList: () => Promise<PersonalDictionaryState>;
      dictionaryCreate: (input: CreateDictionaryEntryInput) => Promise<PersonalDictionaryState>;
      dictionaryUpdate: (id: string, input: UpdateDictionaryEntryInput) => Promise<PersonalDictionaryState>;
      dictionaryDelete: (id: string) => Promise<PersonalDictionaryState>;
      dictionaryRuleCreate: (input: CreateReplacementRuleInput) => Promise<PersonalDictionaryState>;
      dictionaryRuleUpdate: (id: string, input: UpdateReplacementRuleInput) => Promise<PersonalDictionaryState>;
      dictionaryRuleDelete: (id: string) => Promise<PersonalDictionaryState>;
      dictionaryCandidateUpdate: (id: string, input: UpdateVocabularyCandidateInput) => Promise<PersonalDictionaryState>;
      usageDashboard: (query: UsageDashboardQuery) => Promise<UsageDashboardData>;
      generateTitle: (message: string, model: string, provider: string) => Promise<string>;
      setThemeBackground: (isDark: boolean) => void;
    };
  }
}
