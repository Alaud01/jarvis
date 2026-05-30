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

export interface StopStreamRequest {
  conversationId: string;
  assistantMessageId: string;
}
