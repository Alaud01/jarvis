import type {
  Conversation,
  Folder,
  Message,
  ModelInfo,
  SerializedConversation,
  SerializedConversationMetadata,
  SerializedFolder,
  SendMessageStreamRequest,
} from '../types';
import type { FileAttachment } from '../../shared/attachments';

export const SCROLL_BUTTON_BOTTOM_THRESHOLD = 8;
export const CONVERSATION_CACHE_LIMIT = 6;
export const SAVE_DEBOUNCE_MS = 400;
export const STREAM_FLUSH_MS = 60;
export const NEW_CHAT_DRAFT_ID = '__new_chat__';

export const isScrollContainerAtBottom = (container: HTMLElement) => (
  container.scrollHeight - container.scrollTop - container.clientHeight <= SCROLL_BUTTON_BOTTOM_THRESHOLD
);

export function serializeConversation(c: Conversation): SerializedConversation {
  return {
    id: c.id,
    title: c.title,
    timestamp: c.timestamp.toISOString(),
    messages: c.messages.map(m => ({
      id: m.id,
      text: m.text,
      sender: m.sender,
      timestamp: m.timestamp.toISOString(),
      searchSources: m.searchSources,
      attachments: m.attachments,
      compactions: m.compactions?.map(compaction => ({
        ...compaction,
        startedAt: compaction.startedAt.toISOString(),
        completedAt: compaction.completedAt?.toISOString(),
      })),
    })),
    branches: c.branches ? { ...c.branches, archived: serializeConversation({ ...c, messages: c.branches.archived, branches: undefined }).messages } : undefined,
    folderId: c.folderId,
    isPinned: c.isPinned,
  };
}

export function serializeConversationMetadata(c: Conversation): SerializedConversationMetadata {
  return {
    id: c.id,
    title: c.title,
    timestamp: c.timestamp.toISOString(),
    folderId: c.folderId,
    isPinned: c.isPinned,
  };
}

export function deserializeConversation(c: SerializedConversation): Conversation {
  return {
    id: c.id,
    title: c.title,
    timestamp: new Date(c.timestamp),
    messages: c.messages.map(m => ({
      id: m.id,
      text: m.text,
      sender: m.sender,
      timestamp: new Date(m.timestamp),
      searchSources: m.searchSources,
      attachments: m.attachments,
      compactions: m.compactions?.map(compaction => ({
        ...compaction,
        startedAt: new Date(compaction.startedAt),
        completedAt: compaction.completedAt ? new Date(compaction.completedAt) : undefined,
      })),
    })),
    branches: c.branches ? { ...c.branches, archived: deserializeConversation({ ...c, messages: c.branches.archived, branches: undefined }).messages } : undefined,
    folderId: c.folderId ?? null,
    isPinned: Boolean(c.isPinned),
    isLoaded: true,
  };
}

export function deserializeConversationMetadata(c: SerializedConversationMetadata): Conversation {
  return {
    id: c.id,
    title: c.title,
    timestamp: new Date(c.timestamp),
    messages: [],
    folderId: c.folderId ?? null,
    isPinned: Boolean(c.isPinned),
    isLoaded: false,
  };
}

export function serializeFolder(f: Folder): SerializedFolder {
  return {
    id: f.id,
    name: f.name,
    timestamp: f.timestamp.toISOString(),
  };
}

export function deserializeFolder(f: SerializedFolder): Folder {
  return {
    id: f.id,
    name: f.name,
    timestamp: new Date(f.timestamp),
  };
}

export function hashString(value: string, seed = 2166136261): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function hashUnknown(value: unknown, seed = 2166136261): number {
  if (value === null || value === undefined) {
    return hashString(String(value), seed);
  }

  if (typeof value !== 'object') {
    return hashString(String(value), seed);
  }

  if (Array.isArray(value)) {
    return value.reduce((hash, item, index) => (
      hashUnknown(item, hashString(`[${index}]`, hash))
    ), seed);
  }

  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce((hash, key) => (
      hashUnknown((value as Record<string, unknown>)[key], hashString(key, hash))
    ), seed);
}

export function getConversationMetadataRevision(conversations: Conversation[]): string {
  const hash = conversations.reduce((metadataHash, conversation) => (
    hashString(
      `${conversation.id}\u0000${conversation.title}\u0000${conversation.timestamp.toISOString()}\u0000${conversation.folderId ?? ''}\u0000${conversation.isPinned}`,
      metadataHash
    )
  ), 2166136261);
  return `${conversations.length}:${hash}`;
}

export function getConversationRevision(conversation: Conversation): string {
  const hash = conversation.messages.reduce((messageHash, message) => {
    let nextHash = hashString(
      `${message.id}\u0000${message.sender}\u0000${message.timestamp.toISOString()}\u0000${message.text.length}`,
      messageHash
    );
    nextHash = hashString(message.text, nextHash);
    nextHash = hashUnknown(message.searchSources, nextHash);
    nextHash = hashUnknown(message.attachments, nextHash);
    nextHash = hashUnknown(message.compactions, nextHash);
    return nextHash;
  }, hashString(
    `${conversation.id}\u0000${conversation.title}\u0000${conversation.timestamp.toISOString()}\u0000${conversation.folderId ?? ''}\u0000${conversation.isPinned}`,
    2166136261
  ));

  const branches = conversation.branches;
  const branchRevision = branches
    ? `${hashUnknown([branches.contextKey, branches.parents, branches.selected])}:${getConversationRevision({
        ...conversation, messages: branches.archived, branches: undefined,
      })}`
    : '';
  return `${conversation.messages.length}:${hash}:${branchRevision}`;
}

export function getNextFolderName(existingFolders: Folder[]): string {
  const normalizedNames = new Set(
    existingFolders.map(folder => folder.name.trim().toLowerCase())
  );

  if (!normalizedNames.has('new folder')) {
    return 'New Folder';
  }

  let suffix = 2;
  while (normalizedNames.has(`new folder ${suffix}`)) {
    suffix += 1;
  }

  return `New Folder ${suffix}`;
}

export function getProviderForModel(models: ModelInfo[], modelId: string | null): string {
  if (!modelId) return 'ollama';
  const model = models.find(m => m.id === modelId);
  return model?.provider || 'ollama';
}

export function toStreamMessage(message: Pick<Message, 'sender' | 'text' | 'attachments'>): SendMessageStreamRequest['messages'][number] {
  const textAttachments = message.attachments?.filter((attachment: FileAttachment) => attachment.kind !== 'image') ?? [];
  const imageAttachments = message.attachments?.filter((attachment: FileAttachment) => attachment.kind === 'image' && attachment.base64) ?? [];
  const attachmentContext = textAttachments.map(attachment => [
    '',
    `--- Attached file: ${attachment.name}${attachment.truncated ? ' (truncated)' : ''} ---`,
    attachment.content,
    `--- End attached file: ${attachment.name} ---`,
  ].join('\n')).join('\n');

  return {
    role: message.sender === 'user' ? 'user' : 'assistant',
    content: `${message.text}${attachmentContext}`,
    images: imageAttachments.map(attachment => attachment.base64!),
    imageMimeTypes: imageAttachments.map(attachment => attachment.mimeType ?? 'image/png'),
  };
}
