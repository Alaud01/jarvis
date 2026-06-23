import Store from 'electron-store';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserToolRun } from '../shared/browser';
import type { SearchSourceGroup } from '../shared/search';
import type { FileAttachment } from '../shared/attachments';
import type {
  CorrectionObservation,
  LegacyDictionaryEntry,
  ReplacementRule,
  VocabularyCandidate,
  VocabularyEntry,
} from '../shared/dictionary';

export interface SerializedMessage {
  id: string;
  text: string;
  sender: 'user' | 'assistant';
  timestamp: string;
  browserRuns?: BrowserToolRun[];
  searchSources?: SearchSourceGroup[];
  attachments?: FileAttachment[];
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

interface StoreSchema {
  conversations: SerializedConversation[];
  conversationMetadata: SerializedConversationMetadata[];
  conversationMessages: Record<string, SerializedMessage[]>;
  conversationMessageFilesMigrated?: boolean;
  folders: SerializedFolder[];
  selectedModel: string;
  selectedProvider: string;
  openTabIds: string[];
  currentConversationId: string | null;
  opencodeGoApiKey: string;
  openRouterApiKey: string;
  dictionaryEntries: LegacyDictionaryEntry[];
  vocabularyEntries: VocabularyEntry[];
  replacementRules: ReplacementRule[];
  vocabularyCandidates: VocabularyCandidate[];
  correctionObservations: CorrectionObservation[];
}

const store = new Store<StoreSchema>({
  name: 'jarvis',
  defaults: {
    conversations: [],
    conversationMetadata: [],
    conversationMessages: {},
    conversationMessageFilesMigrated: false,
    folders: [],
    selectedModel: '',
    selectedProvider: 'ollama',
    openTabIds: [],
    currentConversationId: null,
    opencodeGoApiKey: '',
    openRouterApiKey: '',
    dictionaryEntries: [],
    vocabularyEntries: [],
    replacementRules: [],
    vocabularyCandidates: [],
    correctionObservations: [],
  },
}) as any;

const conversationStorageDir = path.join(path.dirname((store as { path: string }).path), 'jarvis-conversations');

function ensureConversationStorageDir(): void {
  fs.mkdirSync(conversationStorageDir, { recursive: true });
}

function getConversationPath(id: string): string {
  return path.join(conversationStorageDir, `${encodeURIComponent(id)}.json`);
}

function readConversationFile(id: string): SerializedConversation | null {
  try {
    const raw = fs.readFileSync(getConversationPath(id), 'utf8');
    return JSON.parse(raw) as SerializedConversation;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`Failed to read conversation ${id}:`, error);
    }
    return null;
  }
}

function writeConversationFile(conversation: SerializedConversation): void {
  ensureConversationStorageDir();
  fs.writeFileSync(getConversationPath(conversation.id), `${JSON.stringify(conversation)}\n`, 'utf8');
}

function deleteConversationFile(id: string): void {
  try {
    fs.rmSync(getConversationPath(id), { force: true });
  } catch (error) {
    console.error(`Failed to delete conversation ${id}:`, error);
  }
}

function pruneConversationFiles(validIds: Set<string>): void {
  try {
    if (!fs.existsSync(conversationStorageDir)) {
      return;
    }

    const validFileNames = new Set([...validIds].map(id => `${encodeURIComponent(id)}.json`));
    for (const entry of fs.readdirSync(conversationStorageDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || validFileNames.has(entry.name)) {
        continue;
      }
      fs.rmSync(path.join(conversationStorageDir, entry.name), { force: true });
    }
  } catch (error) {
    console.error('Failed to prune orphaned conversation files:', error);
  }
}

function pruneConversationMessageMap(validIds: Set<string>): void {
  const messages = store.get('conversationMessages', {}) as Record<string, SerializedMessage[]>;
  const nextMessages = Object.fromEntries(
    Object.entries(messages).filter(([id]) => validIds.has(id)),
  ) as Record<string, SerializedMessage[]>;

  if (Object.keys(nextMessages).length !== Object.keys(messages).length) {
    store.set('conversationMessages', nextMessages);
  }
}

function pruneLegacyConversations(validIds: Set<string>): void {
  const legacyConversations = loadLegacyConversations();
  const nextConversations = legacyConversations.filter(conversation => validIds.has(conversation.id));

  if (nextConversations.length !== legacyConversations.length) {
    store.set('conversations', nextConversations);
  }
}

function pruneConversationReferences(validIds: Set<string>): void {
  const openTabIds = loadOpenTabIds();
  const nextOpenTabIds = openTabIds.filter(id => validIds.has(id));
  if (nextOpenTabIds.length !== openTabIds.length) {
    store.set('openTabIds', nextOpenTabIds);
  }

  const currentConversationId = loadCurrentConversationId();
  if (currentConversationId && !validIds.has(currentConversationId)) {
    store.set('currentConversationId', nextOpenTabIds[0] ?? null);
  }
}

function pruneDeletedConversationState(validIds: Set<string>): void {
  pruneConversationFiles(validIds);
  pruneConversationMessageMap(validIds);
  pruneLegacyConversations(validIds);
  pruneConversationReferences(validIds);
}

function conversationToMetadata(conversation: SerializedConversation): SerializedConversationMetadata {
  return {
    id: conversation.id,
    title: conversation.title,
    timestamp: conversation.timestamp,
    folderId: conversation.folderId ?? null,
  };
}

function ensureConversationStorageMigrated(): void {
  if (store.get('conversationMessageFilesMigrated', false) as boolean) {
    return;
  }

  const metadata = store.get('conversationMetadata', []) as SerializedConversationMetadata[];
  const messages = store.get('conversationMessages', {}) as Record<string, SerializedMessage[]>;
  const legacyConversations = store.get('conversations', []) as SerializedConversation[];
  const legacyConversationMap = new Map(legacyConversations.map(conversation => [conversation.id, conversation]));

  if (metadata.length === 0 && legacyConversations.length === 0 && Object.keys(messages).length === 0) {
    store.set('conversationMessageFilesMigrated', true);
    return;
  }

  const nextMetadata = metadata.length > 0
    ? [...metadata]
    : legacyConversations.map(conversationToMetadata);
  const knownIds = new Set(nextMetadata.map(conversation => conversation.id));

  legacyConversations.forEach(conversation => {
    if (!knownIds.has(conversation.id)) {
      nextMetadata.push(conversationToMetadata(conversation));
      knownIds.add(conversation.id);
    }
  });

  nextMetadata.forEach(conversationMetadata => {
    if (readConversationFile(conversationMetadata.id)) {
      return;
    }

    const legacyConversation = legacyConversationMap.get(conversationMetadata.id);
    writeConversationFile({
      ...conversationMetadata,
      messages: legacyConversation?.messages ?? messages[conversationMetadata.id] ?? [],
    });
  });

  store.set('conversationMetadata', nextMetadata);
  store.set('conversationMessages', {});
  store.set('conversations', []);
  store.set('conversationMessageFilesMigrated', true);
  pruneDeletedConversationState(new Set(nextMetadata.map(conversation => conversation.id)));
}

export function loadConversationMetadata(): SerializedConversationMetadata[] {
  ensureConversationStorageMigrated();
  return store.get('conversationMetadata', []) as SerializedConversationMetadata[];
}

export function loadConversation(id: string): SerializedConversation | null {
  ensureConversationStorageMigrated();
  const metadata = loadConversationMetadata().find(c => c.id === id);
  if (!metadata) {
    return null;
  }

  const storedConversation = readConversationFile(id);
  return {
    ...metadata,
    messages: storedConversation?.messages ?? [],
  };
}

export function loadConversations(ids?: string[]): SerializedConversation[] {
  ensureConversationStorageMigrated();
  const metadata = loadConversationMetadata();
  const requestedIds = ids ? new Set(ids) : null;

  return metadata
    .filter(c => !requestedIds || requestedIds.has(c.id))
    .map(c => ({
      ...c,
      messages: readConversationFile(c.id)?.messages ?? [],
    }));
}

export function saveConversationMetadata(metadata: SerializedConversationMetadata[]): void {
  ensureConversationStorageMigrated();
  const validIds = new Set(metadata.map(conversation => conversation.id));
  store.set('conversationMetadata', metadata);
  pruneDeletedConversationState(validIds);
}

export function saveConversation(conversation: SerializedConversation): void {
  ensureConversationStorageMigrated();
  const metadata = loadConversationMetadata();
  const nextMetadata = metadata.some(c => c.id === conversation.id)
    ? metadata.map(c => c.id === conversation.id ? conversationToMetadata(conversation) : c)
    : [conversationToMetadata(conversation), ...metadata];

  store.set('conversationMetadata', nextMetadata);
  writeConversationFile(conversation);
}

export function loadLegacyConversations(): SerializedConversation[] {
  return store.get('conversations', []) as SerializedConversation[];
}

export function saveConversations(conversations: SerializedConversation[]): void {
  const validIds = new Set(conversations.map(conversation => conversation.id));
  store.set('conversationMetadata', conversations.map(conversationToMetadata));
  conversations.forEach(writeConversationFile);
  store.set('conversationMessages', {});
  store.set('conversations', []);
  store.set('conversationMessageFilesMigrated', true);
  pruneDeletedConversationState(validIds);
}

export function deleteConversation(id: string): void {
  ensureConversationStorageMigrated();
  const metadata = loadConversationMetadata();
  const legacyConversations = loadLegacyConversations();
  const conversationMessages = store.get('conversationMessages', {}) as Record<string, SerializedMessage[]>;
  const nextMetadata = metadata.filter(c => c.id !== id);
  const validIds = new Set(nextMetadata.map(conversation => conversation.id));

  deleteConversationFile(id);
  delete conversationMessages[id];
  store.set('conversationMetadata', nextMetadata);
  store.set('conversations', legacyConversations.filter(c => c.id !== id));
  store.set('conversationMessages', conversationMessages);
  pruneConversationReferences(validIds);
}

export function loadFolders(): SerializedFolder[] {
  return store.get('folders', []) as SerializedFolder[];
}

export function saveFolders(folders: SerializedFolder[]): void {
  store.set('folders', folders);
}

export function deleteFolderAndConversations(id: string): void {
  ensureConversationStorageMigrated();
  const metadata = loadConversationMetadata();
  const deletedIds = new Set(metadata.filter(c => c.folderId === id).map(c => c.id));
  const legacyConversations = loadLegacyConversations();
  const conversationMessages = store.get('conversationMessages', {}) as Record<string, SerializedMessage[]>;
  const nextMetadata = metadata.filter(c => c.folderId !== id);
  const validIds = new Set(nextMetadata.map(conversation => conversation.id));

  deletedIds.forEach(conversationId => {
    deleteConversationFile(conversationId);
    delete conversationMessages[conversationId];
  });

  store.set('conversationMetadata', nextMetadata);
  store.set('conversations', legacyConversations.filter(c => c.folderId !== id));
  store.set('conversationMessages', conversationMessages);
  pruneConversationReferences(validIds);
  const folders: SerializedFolder[] = store.get('folders', []);
  store.set('folders', folders.filter(f => f.id !== id));
}

export function loadSelectedModel(): string {
  return store.get('selectedModel', '') as string;
}

export function saveSelectedModel(model: string): void {
  store.set('selectedModel', model);
}

export function loadSelectedProvider(): string {
  return store.get('selectedProvider', 'ollama') as string;
}

export function saveSelectedProvider(provider: string): void {
  store.set('selectedProvider', provider);
}

export function loadOpenCodeGoApiKey(): string {
  return store.get('opencodeGoApiKey', '') as string;
}

export function saveOpenCodeGoApiKey(key: string): void {
  store.set('opencodeGoApiKey', key);
}

export function loadOpenRouterApiKey(): string {
  return store.get('openRouterApiKey', '') as string;
}

export function saveOpenRouterApiKey(key: string): void {
  store.set('openRouterApiKey', key);
}

export function loadOpenTabIds(): string[] {
  return store.get('openTabIds', []) as string[];
}

export function saveOpenTabIds(tabIds: string[]): void {
  store.set('openTabIds', tabIds);
}

export function loadCurrentConversationId(): string | null {
  return store.get('currentConversationId', null) as string | null;
}

export function saveCurrentConversationId(id: string | null): void {
  store.set('currentConversationId', id);
}

export function loadDictionaryEntries(): LegacyDictionaryEntry[] {
  return store.get('dictionaryEntries', []) as LegacyDictionaryEntry[];
}

export function saveDictionaryEntries(entries: LegacyDictionaryEntry[]): void {
  store.set('dictionaryEntries', entries);
}

export function loadVocabularyEntries(): VocabularyEntry[] {
  return store.get('vocabularyEntries', []) as VocabularyEntry[];
}

export function saveVocabularyEntries(entries: VocabularyEntry[]): void {
  store.set('vocabularyEntries', entries);
}

export function loadReplacementRules(): ReplacementRule[] {
  return store.get('replacementRules', []) as ReplacementRule[];
}

export function saveReplacementRules(rules: ReplacementRule[]): void {
  store.set('replacementRules', rules);
}

export function loadVocabularyCandidates(): VocabularyCandidate[] {
  return store.get('vocabularyCandidates', []) as VocabularyCandidate[];
}

export function saveVocabularyCandidates(candidates: VocabularyCandidate[]): void {
  store.set('vocabularyCandidates', candidates);
}

export function loadCorrectionObservations(): CorrectionObservation[] {
  return store.get('correctionObservations', []) as CorrectionObservation[];
}

export function saveCorrectionObservations(observations: CorrectionObservation[]): void {
  store.set('correctionObservations', observations);
}

export default store;
