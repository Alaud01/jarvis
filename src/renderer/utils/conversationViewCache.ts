import type { Message } from '../types';

export interface ConversationViewport {
  scrollTop: number;
  height: number;
}

type EstimateMessageHeight = (message: Message) => number;

const MAX_CACHED_CONVERSATION_VIEWS = 6;
const LAYOUT_WIDTH_TOLERANCE_PX = 2;

const messageLayoutIsEqual = (left: Message, right: Message): boolean => (
  left.text === right.text
  && left.sender === right.sender
  && left.isStreaming === right.isStreaming
  && left.searchSources === right.searchSources
  && left.attachments === right.attachments
  && left.compactions === right.compactions
);

/**
 * Fenwick tree-backed height index for a single conversation. It retains only
 * the six most recently used conversations and makes individual measurements,
 * offset lookups, and scroll-position lookups logarithmic.
 */
export class ConversationHeightIndex {
  private messages: Message[] | null = null;
  private messageSnapshots: Message[] = [];
  private indexByMessageId = new Map<string, number>();
  private values: number[] = [];
  private tree: number[] = [0];

  invalidate(): void {
    this.messages = null;
  }

  sync(
    messages: Message[],
    measuredHeights: Map<string, number>,
    estimateHeight: EstimateMessageHeight,
  ): void {
    if (this.messages === messages) {
      return;
    }

    const hasSameShape = messages.length === this.messageSnapshots.length
      && messages.every((message, index) => message.id === this.messageSnapshots[index]?.id);

    if (hasSameShape) {
      messages.forEach((message, index) => {
        const previousMessage = this.messageSnapshots[index];
        if (previousMessage === message) {
          return;
        }

        if (!messageLayoutIsEqual(previousMessage, message)) {
          measuredHeights.delete(message.id);
          this.updateAt(index, estimateHeight(message));
        }
        this.messageSnapshots[index] = message;
      });
      this.messages = messages;
      return;
    }

    const previousMessagesById = new Map(
      this.messageSnapshots.map(message => [message.id, message]),
    );
    const liveMessageIds = new Set(messages.map(message => message.id));
    measuredHeights.forEach((_height, messageId) => {
      if (!liveMessageIds.has(messageId)) {
        measuredHeights.delete(messageId);
      }
    });

    messages.forEach(message => {
      const previousMessage = previousMessagesById.get(message.id);
      if (previousMessage && !messageLayoutIsEqual(previousMessage, message)) {
        measuredHeights.delete(message.id);
      }
    });

    this.messages = messages;
    this.messageSnapshots = [...messages];
    this.indexByMessageId = new Map(messages.map((message, index) => [message.id, index]));
    this.values = messages.map(message => measuredHeights.get(message.id) ?? estimateHeight(message));
    this.tree = new Array(this.values.length + 1).fill(0);
    this.values.forEach((height, index) => {
      this.add(index, height);
    });
  }

  setMeasuredHeight(messageId: string, height: number): boolean {
    const index = this.indexByMessageId.get(messageId);
    if (index === undefined) {
      return false;
    }

    const previousHeight = this.values[index] ?? 0;
    if (Math.abs(previousHeight - height) <= 1) {
      return false;
    }

    this.updateAt(index, height);
    return true;
  }

  getOffset(index: number): number {
    return this.prefixSum(Math.max(0, Math.min(index, this.values.length)));
  }

  getTotalHeight(): number {
    return this.prefixSum(this.values.length);
  }

  findIndexAtOffset(target: number): number {
    if (this.values.length === 0) {
      return 0;
    }

    let treeIndex = 0;
    let accumulatedHeight = 0;
    let bit = 1;
    while (bit * 2 <= this.values.length) {
      bit *= 2;
    }

    for (; bit > 0; bit = Math.floor(bit / 2)) {
      const nextIndex = treeIndex + bit;
      if (
        nextIndex <= this.values.length
        && accumulatedHeight + this.tree[nextIndex] <= target
      ) {
        treeIndex = nextIndex;
        accumulatedHeight += this.tree[nextIndex];
      }
    }

    return Math.min(treeIndex, this.values.length - 1);
  }

  private updateAt(index: number, height: number): void {
    const previousHeight = this.values[index] ?? 0;
    this.values[index] = height;
    this.add(index, height - previousHeight);
  }

  private add(index: number, delta: number): void {
    for (let treeIndex = index + 1; treeIndex < this.tree.length; treeIndex += treeIndex & -treeIndex) {
      this.tree[treeIndex] += delta;
    }
  }

  private prefixSum(count: number): number {
    let total = 0;
    for (let treeIndex = count; treeIndex > 0; treeIndex -= treeIndex & -treeIndex) {
      total += this.tree[treeIndex];
    }
    return total;
  }
}

class ConversationViewState {
  readonly measuredHeights = new Map<string, number>();
  readonly heightIndex = new ConversationHeightIndex();
  viewport: ConversationViewport = { scrollTop: 0, height: 0 };
  private layoutWidth = 0;

  syncMessages(messages: Message[], estimateHeight: EstimateMessageHeight): void {
    this.heightIndex.sync(messages, this.measuredHeights, estimateHeight);
  }

  setMeasuredHeight(messageId: string, height: number): boolean {
    if (!this.heightIndex.setMeasuredHeight(messageId, height)) {
      return false;
    }
    this.measuredHeights.set(messageId, height);
    return true;
  }

  setLayoutWidth(width: number): boolean {
    if (width <= 0) {
      return false;
    }
    if (this.layoutWidth === 0) {
      this.layoutWidth = width;
      return false;
    }
    if (Math.abs(this.layoutWidth - width) <= LAYOUT_WIDTH_TOLERANCE_PX) {
      return false;
    }

    this.layoutWidth = width;
    this.measuredHeights.clear();
    this.heightIndex.invalidate();
    return true;
  }
}

const conversationViewCache = new Map<string, ConversationViewState>();

const cacheKeyForConversation = (conversationId: string | null): string => (
  conversationId ?? '__new-conversation__'
);

function getConversationViewState(conversationId: string | null): ConversationViewState {
  const cacheKey = cacheKeyForConversation(conversationId);
  const existing = conversationViewCache.get(cacheKey);
  const state = existing ?? new ConversationViewState();

  // Map insertion order is the LRU order. Touch hits as well as misses.
  if (existing) {
    conversationViewCache.delete(cacheKey);
  }
  conversationViewCache.set(cacheKey, state);

  while (conversationViewCache.size > MAX_CACHED_CONVERSATION_VIEWS) {
    const oldestKey = conversationViewCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    conversationViewCache.delete(oldestKey);
  }

  return state;
}

export function getConversationViewport(conversationId: string | null): ConversationViewport {
  return getConversationViewState(conversationId).viewport;
}

export function setConversationViewport(
  conversationId: string | null,
  viewport: ConversationViewport,
): void {
  getConversationViewState(conversationId).viewport = viewport;
}

export function syncConversationHeightIndex(
  conversationId: string | null,
  messages: Message[],
  estimateHeight: EstimateMessageHeight,
): ConversationHeightIndex {
  const state = getConversationViewState(conversationId);
  state.syncMessages(messages, estimateHeight);
  return state.heightIndex;
}

export function setConversationMessageHeight(
  conversationId: string | null,
  messageId: string,
  height: number,
): boolean {
  return getConversationViewState(conversationId).setMeasuredHeight(messageId, height);
}

export function setConversationLayoutWidth(
  conversationId: string | null,
  width: number,
): boolean {
  return getConversationViewState(conversationId).setLayoutWidth(width);
}
