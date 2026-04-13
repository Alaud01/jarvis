import Store from 'electron-store';

export interface SerializedMessage {
  id: string;
  text: string;
  sender: 'user' | 'assistant';
  timestamp: string;
}

export interface SerializedConversation {
  id: string;
  title: string;
  timestamp: string;
  messages: SerializedMessage[];
}

interface StoreSchema {
  conversations: SerializedConversation[];
  selectedModel: string;
}

const store = new Store<StoreSchema>({
  name: 'rhandy',
  defaults: {
    conversations: [],
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

export function loadSelectedModel(): string {
  return store.get('selectedModel', '') as string;
}

export function saveSelectedModel(model: string): void {
  store.set('selectedModel', model);
}

export default store;