export interface StreamEventContext {
  conversationId: string;
  assistantMessageId: string;
}

export interface StreamChunkEvent extends StreamEventContext {
  chunk: string;
}

export interface StreamErrorEvent extends StreamEventContext {
  error: string;
}

export type CompactionPhase = 'started' | 'completed' | 'failed';

export interface CompactionEvent extends StreamEventContext {
  compactionId: string;
  phase: CompactionPhase;
  timestamp: string;
}

export interface StopStreamRequest {
  conversationId: string;
  assistantMessageId: string;
}
