export const MESSAGE_COUNT_VIRTUALIZATION_THRESHOLD = 80;
export const TOTAL_TEXT_VIRTUALIZATION_THRESHOLD = 24_000;
export const SINGLE_MESSAGE_TEXT_VIRTUALIZATION_THRESHOLD = 8_000;

interface MessageText {
  text: string;
}

/**
 * Message count alone is a poor proxy for render cost: a few long Markdown
 * responses can create more DOM and syntax-highlighting work than hundreds of
 * short messages. Keep small chats simple, but window any conversation whose
 * count or text payload is large enough to make a full remount expensive.
 */
export function shouldVirtualizeMessages(messages: readonly MessageText[]): boolean {
  if (messages.length > MESSAGE_COUNT_VIRTUALIZATION_THRESHOLD) {
    return true;
  }

  let totalTextLength = 0;
  for (const message of messages) {
    const messageTextLength = message.text.length;
    if (messageTextLength >= SINGLE_MESSAGE_TEXT_VIRTUALIZATION_THRESHOLD) {
      return true;
    }

    totalTextLength += messageTextLength;
    if (totalTextLength >= TOTAL_TEXT_VIRTUALIZATION_THRESHOLD) {
      return true;
    }
  }

  return false;
}
