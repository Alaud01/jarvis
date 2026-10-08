import type { ChatMessage } from './types';

export const TOOL_IMAGE_FOLLOW_UP_TEXT = 'Image output from the tool call above:';
const OMITTED_IMAGE_NOTE = '[Screenshot omitted from context.]';
const UNSUPPORTED_IMAGE_NOTE = '[Screenshot omitted: the selected model does not accept image input.]';

export function parseImageDataUrl(url: string): { data: string; mimeType: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  return match ? { mimeType: match[1], data: match[2] } : null;
}

/** Converts tool-result data URLs into ChatMessage image fields. */
export function toToolImageFields(imageUrls?: string[]): Pick<ChatMessage, 'images' | 'imageMimeTypes'> {
  const parsed = (imageUrls ?? []).map(parseImageDataUrl).filter(image => image !== null);
  if (!parsed.length) return {};
  return {
    images: parsed.map(image => image.data),
    imageMimeTypes: parsed.map(image => image.mimeType),
  };
}

export function hasToolImages(messages: ChatMessage[]): boolean {
  return messages.some(message => message.role === 'tool' && message.images?.length);
}

/** Drops images from tool messages in place, leaving a note so the model knows a screenshot existed. */
export function stripToolImages(messages: ChatMessage[], reason: 'superseded' | 'unsupported'): void {
  const note = reason === 'unsupported' ? UNSUPPORTED_IMAGE_NOTE : OMITTED_IMAGE_NOTE;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== 'tool' || !message.images?.length) continue;
    const { images: _images, imageMimeTypes: _mimeTypes, ...rest } = message;
    messages[index] = { ...rest, content: `${message.content}\n${note}` };
  }
}

export function isImageInputUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\(4\d\d\)/.test(message) && /image|vision|multi-?modal|modalit/i.test(message);
}

/**
 * Chat Completions only accepts text in `role: "tool"` messages, so images
 * from a run of consecutive tool results are sent in one user message placed
 * after the run (tool messages must directly follow their assistant turn).
 */
export function withToolImageFollowUps<T>(
  messages: ChatMessage[],
  convert: (message: ChatMessage) => T,
  buildImageMessage: (images: Array<{ image: string; mimeType?: string }>) => T,
): T[] {
  const result: T[] = [];
  let pending: Array<{ image: string; mimeType?: string }> = [];
  const flush = () => {
    if (!pending.length) return;
    result.push(buildImageMessage(pending));
    pending = [];
  };

  for (const message of messages) {
    if (message.role !== 'tool') flush();
    result.push(convert(message));
    if (message.role === 'tool') {
      message.images?.forEach((image, index) => {
        pending.push({ image, mimeType: message.imageMimeTypes?.[index] });
      });
    }
  }
  flush();
  return result;
}
