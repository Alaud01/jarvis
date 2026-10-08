import type { ConversationBranches } from '../shared/conversationBranches';
import Store from 'electron-store';
import { ConversationFiles, SerialTaskQueue } from './conversationFiles';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SearchSourceGroup } from '../shared/search';
import type { FileAttachment } from '../shared/attachments';
import { isWorkspaceView } from '../shared/workspaceViews';
import type { WorkspaceView } from '../shared/workspaceViews';
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
  searchSources?: SearchSourceGroup[];
  attachments?: FileAttachment[];
  compactions?: {
    id: string;
    status: 'in_progress' | 'completed' | 'failed';
    startedAt: string;
    completedAt?: string;
  }[];
}

export interface SerializedConversation {
  id: string;
  title: string;
  timestamp: string;
  messages: SerializedMessage[];
  branches?: ConversationBranches<SerializedMessage>;
  folderId: string | null;
  isPinned?: boolean;
}

export interface SerializedConversationMetadata {
  id: string;
  title: string;
  timestamp: string;
  folderId: string | null;
  isPinned?: boolean;
}

export interface SerializedFolder {
  id: string;
  name: string;
  timestamp: string;
}

export interface DeletedConversationMetadata extends SerializedConversationMetadata {
  deletedAt: string;
  expiresAt: string;
}

interface ConversationDeletion {
  id: string;
  metadata?: DeletedConversationMetadata;
  restoredId?: string;
  purgePending?: boolean;
}

export const CONVERSATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface StoreSchema {
  conversations: SerializedConversation[];
  conversationMetadata: SerializedConversationMetadata[];
  conversationMessages: Record<string, SerializedMessage[]>;
  conversationMessageFilesMigrated?: boolean;
  conversationDeletions: ConversationDeletion[];
  folders: SerializedFolder[];
  selectedModel: string;
  selectedReasoningEffort: string;
  selectedProvider: string;
  currentConversationId: string | null;
  workspaceView: WorkspaceView;
  scrollPositions: Record<string, number>;
  conversationDrafts: Record<string, string>;
  dictionaryEntries: LegacyDictionaryEntry[];
  vocabularyEntries: VocabularyEntry[];
  replacementRules: ReplacementRule[];
  vocabularyCandidates: VocabularyCandidate[];
  correctionObservations: CorrectionObservation[];
}

type RuntimeStore = {
  path: string;
  get<Key extends keyof StoreSchema>(key: Key, defaultValue?: StoreSchema[Key]): StoreSchema[Key];
  set<Key extends keyof StoreSchema>(key: Key, value: StoreSchema[Key]): void;
  delete(key: string): void;
};

const store = new Store<StoreSchema>({
  name: 'jarvis',
  defaults: {
    conversations: [],
    conversationMetadata: [],
    conversationMessages: {},
    conversationMessageFilesMigrated: false,
    conversationDeletions: [],
    folders: [],
    selectedModel: '',
    selectedReasoningEffort: '',
    selectedProvider: 'ollama',
    currentConversationId: null,
    workspaceView: 'chat',
    scrollPositions: {},
    conversationDrafts: {},
    dictionaryEntries: [],
    vocabularyEntries: [],
    replacementRules: [],
    vocabularyCandidates: [],
    correctionObservations: [],
  },
}) as unknown as RuntimeStore;

const conversationStorageDir = path.join(path.dirname((store as { path: string }).path), 'jarvis-conversations');

const conversationFiles = new ConversationFiles<SerializedConversation>(conversationStorageDir);
const conversationQueue = new SerialTaskQueue();
// Tombstones outlive trash contents so delayed snapshots cannot resurrect old IDs.
const isDeleted = (id: string): boolean => getDeletions().some(entry => entry.id === id);
const getDeletions = (): ConversationDeletion[] => store.get('conversationDeletions', []);
export const flushConversationStorage = (): Promise<void> => conversationQueue.flush();

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
  const currentConversationId = loadCurrentConversationId();
  if (currentConversationId && !validIds.has(currentConversationId)) {
    store.set('currentConversationId', null);
  }
}

function pruneConversationDrafts(validIds: Set<string>): void {
  const drafts = store.get('conversationDrafts', {}) as Record<string, string>;
  const nextDrafts = Object.fromEntries(
    Object.entries(drafts).filter(([id]) => validIds.has(id) || id.startsWith('__')),
  ) as Record<string, string>;

  if (Object.keys(nextDrafts).length !== Object.keys(drafts).length) {
    store.set('conversationDrafts', nextDrafts);
  }
}

async function pruneDeletedConversationState(validIds: Set<string>): Promise<void> {
  // Never infer file deletion from an index: it may lag a durable file write.
  pruneConversationMessageMap(validIds);
  pruneLegacyConversations(validIds);
  pruneConversationReferences(validIds);
  pruneConversationDrafts(validIds);
}

function conversationToMetadata(conversation: SerializedConversation): SerializedConversationMetadata {
  return {
    id: conversation.id,
    title: conversation.title,
    timestamp: conversation.timestamp,
    folderId: conversation.folderId ?? null,
    isPinned: Boolean(conversation.isPinned),
  };
}

async function ensureConversationStorageMigrated(): Promise<void> {
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

  for (const conversationMetadata of nextMetadata) {
    if (await conversationFiles.read(conversationMetadata.id)) {
      continue;
    }

    const legacyConversation = legacyConversationMap.get(conversationMetadata.id);
    await conversationFiles.write({
      ...conversationMetadata,
      messages: legacyConversation?.messages ?? messages[conversationMetadata.id] ?? [],
      branches: legacyConversation?.branches,
    });
  }

  store.set('conversationMetadata', nextMetadata);
  store.set('conversationMessages', {});
  store.set('conversations', []);
  store.set('conversationMessageFilesMigrated', true);
  await pruneDeletedConversationState(new Set(nextMetadata.map(conversation => conversation.id)));
}

function getConversationMetadata(): SerializedConversationMetadata[] {
  return store.get('conversationMetadata', []).filter(entry => !isDeleted(entry.id));
}

async function purgeDeletedConversation(id: string): Promise<void> {
  // Commit purge intent first. A crash or failed unlink is retried, never restored.
  store.set('conversationDeletions', getDeletions().map(item => item.id === id
    ? { id, purgePending: true } : item));
  await conversationFiles.delete(id);
  store.set('conversationDeletions', getDeletions().map(item => item.id === id
    ? { id } : item));
}

async function cleanExpiredConversations(): Promise<void> {
  for (const entry of getDeletions()) {
    if (entry.purgePending || (entry.metadata && Date.parse(entry.metadata.expiresAt) <= Date.now())) {
      try {
        await purgeDeletedConversation(entry.id);
      } catch (error) {
        console.error(`Failed to purge deleted conversation ${entry.id}; will retry:`, error);
      }
    }
  }
}

async function prepareConversationStorage(): Promise<void> {
  await ensureConversationStorageMigrated();
  await cleanExpiredConversations();
}

export function cleanupDeletedConversations(): Promise<void> {
  return conversationQueue.run(prepareConversationStorage);
}

export function startDeletedConversationCleanup(): () => void {
  const cleanup = (): void => {
    void cleanupDeletedConversations().catch(error => console.error('Failed to clean recently deleted conversations:', error));
  };
  cleanup();
  const timer = setInterval(cleanup, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

async function softDeleteConversations(metadata: SerializedConversationMetadata[]): Promise<void> {
  if (!metadata.length) return;
  // Validate before committing the tombstones; preserve the complete files in place.
  for (const entry of metadata) await readStoredConversation(entry);
  const now = Date.now();
  store.set('conversationDeletions', [...getDeletions(), ...metadata.map(entry => ({
    id: entry.id,
    metadata: { ...entry, deletedAt: new Date(now).toISOString(), expiresAt: new Date(now + CONVERSATION_RETENTION_MS).toISOString() },
  }))]);
  const remaining = getConversationMetadata();
  store.set('conversationMetadata', remaining);
  await pruneDeletedConversationState(new Set(remaining.map(entry => entry.id)));
}

export function listDeletedConversations(): Promise<DeletedConversationMetadata[]> {
  return conversationQueue.run(async () => {
    await prepareConversationStorage();
    return getDeletions().flatMap(entry => !entry.purgePending && entry.metadata
      && Date.parse(entry.metadata.expiresAt) > Date.now() ? [entry.metadata] : [])
      .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  });
}

export function restoreConversation(id: string): Promise<SerializedConversation> {
  return conversationQueue.run(async () => {
    await prepareConversationStorage();
    const entry = getDeletions().find(item => item.id === id);
    if (!entry?.metadata || entry.purgePending || !(Date.parse(entry.metadata.expiresAt) > Date.now())) {
      throw new Error('Deleted conversation is no longer available.');
    }
    const restoredId = entry.restoredId ?? randomUUID();
    // Journal the destination before writing, making a failed restore retryable.
    store.set('conversationDeletions', getDeletions().map(item => item.id === id ? { ...item, restoredId } : item));
    const existing = getConversationMetadata().find(item => item.id === restoredId);
    const { deletedAt: _deletedAt, expiresAt: _expiresAt, ...metadata } = entry.metadata;
    const restored = existing ? await readStoredConversation(existing) : {
      ...await readStoredConversation(metadata),
      id: restoredId,
      folderId: loadFolders().some(folder => folder.id === metadata.folderId) ? metadata.folderId : null,
    };
    if (!existing) {
      await conversationFiles.write(restored);
      store.set('conversationMetadata', [conversationToMetadata(restored), ...getConversationMetadata()]);
    }
    // Publish the new durable copy before scheduling removal of the old one.
    store.set('conversationDeletions', getDeletions().map(item => item.id === id ? { id, purgePending: true } : item));
    return restored;
  });
}

export function permanentlyDeleteConversation(id: string): Promise<void> {
  return conversationQueue.run(async () => {
    await prepareConversationStorage();
    if (!isDeleted(id)) throw new Error('Only recently deleted conversations can be permanently deleted.');
    await purgeDeletedConversation(id);
  });
}

export function loadConversationMetadata(): Promise<SerializedConversationMetadata[]> {
  return conversationQueue.run(async () => {
    await prepareConversationStorage();
    return getConversationMetadata();
  });
}

async function readStoredConversation(metadata: SerializedConversationMetadata): Promise<SerializedConversation> {
  const stored = await conversationFiles.read(metadata.id);
  if (!stored) {
    throw new Error(`Conversation ${metadata.id} is missing. Refusing to replace it with an empty transcript.`);
  }
  return { ...stored, ...metadata };
}

export function loadConversation(id: string): Promise<SerializedConversation | null> {
  return conversationQueue.run(async () => {
    await prepareConversationStorage();
    const metadata = getConversationMetadata().find(c => c.id === id);
    return metadata ? readStoredConversation(metadata) : null;
  });
}

export function loadConversations(ids?: string[]): Promise<SerializedConversation[]> {
  return conversationQueue.run(async () => {
    await prepareConversationStorage();
    const requestedIds = ids ? new Set(ids) : null;
    const conversations: SerializedConversation[] = [];
    for (const metadata of getConversationMetadata()) {
      if (!requestedIds || requestedIds.has(metadata.id)) {
        conversations.push(await readStoredConversation(metadata));
      }
    }
    return conversations;
  });
}

export function saveConversationMetadata(metadata: SerializedConversationMetadata[]): Promise<void> {
  return conversationQueue.run(async () => {
    await prepareConversationStorage();
    const nextMetadata = metadata.filter(c => !isDeleted(c.id));
    const suppliedIds = new Set(nextMetadata.map(c => c.id));
    nextMetadata.push(...getConversationMetadata().filter(c => !suppliedIds.has(c.id)));
    store.set('conversationMetadata', nextMetadata);
    // List edits are not deletions. Only explicit delete/replace operations may
    // prune files, so a stale list cannot destroy a newer conversation snapshot.
  });
}

export function saveConversation(conversation: SerializedConversation): Promise<void> {
  return conversationQueue.run(async () => {
    await prepareConversationStorage();
    if (isDeleted(conversation.id)) return;
    await conversationFiles.write(conversation);
    const metadata = getConversationMetadata();
    const nextMetadata = metadata.some(c => c.id === conversation.id)
      ? metadata.map(c => c.id === conversation.id ? conversationToMetadata(conversation) : c)
      : [conversationToMetadata(conversation), ...metadata];
    store.set('conversationMetadata', nextMetadata);
  });
}

export function loadLegacyConversations(): SerializedConversation[] {
  return store.get('conversations', []);
}

export function saveConversations(conversations: SerializedConversation[]): Promise<void> {
  return conversationQueue.run(async () => {
    await prepareConversationStorage();
    const remaining = conversations.filter(c => !isDeleted(c.id));
    for (const conversation of remaining) await conversationFiles.write(conversation);
    const remainingIds = new Set(remaining.map(c => c.id));
    await softDeleteConversations(getConversationMetadata().filter(c => !remainingIds.has(c.id)));
    store.set('conversationMetadata', remaining.map(conversationToMetadata));
    store.set('conversationMessages', {});
    store.set('conversations', []);
    store.set('conversationMessageFilesMigrated', true);
    await pruneDeletedConversationState(new Set(remaining.map(c => c.id)));
  });
}

export function deleteConversation(id: string): Promise<void> {
  return conversationQueue.run(async () => {
    await prepareConversationStorage();
    await softDeleteConversations(getConversationMetadata().filter(c => c.id === id));
  });
}

export function loadFolders(): SerializedFolder[] {
  return store.get('folders', []);
}

export function saveFolders(folders: SerializedFolder[]): void {
  store.set('folders', folders);
}

export function deleteFolderAndConversations(id: string): Promise<string[]> {
  return conversationQueue.run(async () => {
    await prepareConversationStorage();
    const metadata = getConversationMetadata();
    const deletedIds = metadata.filter(c => c.folderId === id).map(c => c.id);
    await softDeleteConversations(metadata.filter(c => c.folderId === id));
    store.set('folders', loadFolders().filter(f => f.id !== id));
    return deletedIds;
  });
}

export function loadSelectedModel(): string {
  return store.get('selectedModel', '') as string;
}

export function saveSelectedModel(model: string): void {
  store.set('selectedModel', model);
}

export function loadSelectedReasoningEffort(): string {
  return store.get('selectedReasoningEffort', '') as string;
}

export function saveSelectedReasoningEffort(effort: string): void {
  store.set('selectedReasoningEffort', effort);
}

export function loadSelectedProvider(): string {
  return store.get('selectedProvider', 'ollama') as string;
}

export function saveSelectedProvider(provider: string): void {
  store.set('selectedProvider', provider);
}

export function deleteLegacyStoredProviderApiKeys(): void {
  store.delete('opencodeGoApiKey');
  store.delete('openRouterApiKey');
}

export function loadCurrentConversationId(): string | null {
  return store.get('currentConversationId', null) as string | null;
}

export function saveCurrentConversationId(id: string | null): void {
  store.set('currentConversationId', id);
}

export function loadWorkspaceView(): WorkspaceView {
  const stored = store.get('workspaceView', 'chat');
  return isWorkspaceView(stored) ? stored : 'chat';
}

export function saveWorkspaceView(view: WorkspaceView): void {
  store.set('workspaceView', view);
}

export function loadScrollPositions(): Record<string, number> {
  const stored = store.get('scrollPositions', {});
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return {};
  }

  const positions: Record<string, number> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      positions[key] = value;
    }
  }
  return positions;
}

export function saveScrollPositions(positions: Record<string, number>): void {
  store.set('scrollPositions', positions);
}

export function loadConversationDrafts(): Record<string, string> {
  return store.get('conversationDrafts', {}) as Record<string, string>;
}

export function saveConversationDrafts(drafts: Record<string, string>): void {
  store.set('conversationDrafts', drafts);
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
