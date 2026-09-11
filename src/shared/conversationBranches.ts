/** Active messages remain the public transcript; only inactive nodes live in the archive. */
export interface ConversationBranches<M> {
  contextKey?: string;
  archived: M[];
  parents: Record<string, string | null>;
  selected: Record<string, string>;
}
interface Node { id: string; isStreaming?: boolean }
interface Transcript<M> { messages: M[]; branches?: ConversationBranches<M> }
const key = (parent: string | null) => parent === null ? 'root' : `message:${parent}`;

function indexTranscript<M extends Node>(conversation: Transcript<M>) {
  const nodes = new Map((conversation.branches?.archived ?? []).map(m => [m.id, m]));
  const parents = { ...conversation.branches?.parents };
  const selected = { ...conversation.branches?.selected };
  let parent: string | null = null;
  for (const message of conversation.messages) {
    nodes.set(message.id, message);
    parents[message.id] = parent;
    selected[key(parent)] = message.id;
    parent = message.id;
  }
  return { nodes, parents, selected };
}

export function forkConversation<C extends Transcript<M>, M extends Node>(conversation: C, index: number, replacement: M[]): C {
  if (index < 0 || index >= conversation.messages.length || conversation.messages.some(m => m.isStreaming)) return conversation;
  const { nodes, parents, selected } = indexTranscript(conversation);
  const messages = [...conversation.messages.slice(0, index), ...replacement];
  let parent = index > 0 ? messages[index - 1].id : null;
  for (const message of replacement) {
    parents[message.id] = parent;
    selected[key(parent)] = message.id;
    parent = message.id;
  }
  const activeIds = new Set(messages.map(m => m.id));
  return { ...conversation, messages, branches: { contextKey: replacement[0]?.id, parents, selected, archived: [...nodes.values()].filter(m => !activeIds.has(m.id)) } };
}

export function selectConversationVersion<C extends Transcript<M>, M extends Node>(conversation: C, messageId: string, targetId: string): C {
  if (!conversation.branches || conversation.messages.some(m => m.isStreaming)) return conversation;
  const index = conversation.messages.findIndex(m => m.id === messageId);
  if (index < 0 || messageId === targetId) return conversation;
  const { nodes, parents, selected } = indexTranscript(conversation);
  if (!nodes.has(targetId) || parents[targetId] !== parents[messageId]) return conversation;
  const messages = conversation.messages.slice(0, index);
  const seen = new Set(messages.map(m => m.id));
  selected[key(parents[targetId])] = targetId;
  let next: string | undefined = targetId;
  while (next && nodes.has(next) && !seen.has(next)) {
    seen.add(next);
    messages.push(nodes.get(next)!);
    const child: string | undefined = selected[key(next)];
    next = child && parents[child] === next ? child : undefined;
  }
  return { ...conversation, messages, branches: { contextKey: targetId, parents, selected, archived: [...nodes.values()].filter(m => !seen.has(m.id)) } };
}

export function getConversationVersions<M extends Node>(conversation: Transcript<M>): Record<string, string[]> {
  if (!conversation.branches) return {};
  const { parents } = indexTranscript(conversation);
  const siblings = new Map<string, string[]>();
  for (const [id, parent] of Object.entries(parents)) {
    const group = key(parent);
    const ids = siblings.get(group) ?? [];
    ids.push(id);
    siblings.set(group, ids);
  }
  return Object.fromEntries(conversation.messages.flatMap(message => {
    const ids = siblings.get(key(parents[message.id]))!;
    return ids.length > 1 ? [[message.id, ids]] : [];
  }));
}
