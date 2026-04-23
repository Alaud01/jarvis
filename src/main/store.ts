import Store from 'electron-store';
import type { BrowserToolRun } from '../shared/browser';

export type SerializedBrowserToolRun = BrowserToolRun;

export interface SerializedMessage {
  id: string;
  text: string;
  sender: 'user' | 'assistant';
  timestamp: string;
  toolRuns?: SerializedBrowserToolRun[];
}

export interface SerializedConversation {
  id: string;
  title: string;
  timestamp: string;
  messages: SerializedMessage[];
  folderId: string | null;
}

export interface SerializedFolder {
  id: string;
  name: string;
  timestamp: string;
}

interface StoreSchema {
  conversations: SerializedConversation[];
  folders: SerializedFolder[];
  selectedModel: string;
}

const store = new Store<StoreSchema>({
  name: 'jarvis',
  defaults: {
    conversations: [],
    folders: [],
    selectedModel: '',
  },
}) as any;

export function loadConversations(): SerializedConversation[] {
  return store.get('conversations', []) as SerializedConversation[];
}

export function saveConversations(conversations: SerializedConversation[]): void {
  store.set('conversations', conversations);
}

export function deleteConversation(id: string): void {
  const conversations: SerializedConversation[] = store.get('conversations', []);
  store.set('conversations', conversations.filter(c => c.id !== id));
}

export function loadFolders(): SerializedFolder[] {
  return store.get('folders', []) as SerializedFolder[];
}

export function saveFolders(folders: SerializedFolder[]): void {
  store.set('folders', folders);
}

export function deleteFolderAndConversations(id: string): void {
  const conversations: SerializedConversation[] = store.get('conversations', []);
  store.set('conversations', conversations.filter(c => c.folderId !== id));
  const folders: SerializedFolder[] = store.get('folders', []);
  store.set('folders', folders.filter(f => f.id !== id));
}

export function loadSelectedModel(): string {
  return store.get('selectedModel', '') as string;
}

export function saveSelectedModel(model: string): void {
  store.set('selectedModel', model);
}

export default store;