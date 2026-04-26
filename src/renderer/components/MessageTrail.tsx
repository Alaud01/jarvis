import React from 'react';

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'assistant';
  timestamp: Date;
  isStreaming?: boolean;
}

interface MessageTrailProps {
  messages: Message[];
  onScrollToMessage: (messageId: string, headerIndex?: number) => void;
}

interface HeaderEntry {
  level: 1 | 2 | 3;
  text: string;
}

const parseHeaders = (text: string): HeaderEntry[] => {
  let cleanText = text;
  cleanText = cleanText.replace(/(?:<thinking>|思考)([\s\S]*?)(?:<\/thinking>|<\/思考>)/g, '');
  cleanText = cleanText.replace(/Thinking\.\.\.\n[\s\S]*?\n\.\.\.done thinking\./g, '');
  cleanText = cleanText.replace(/Thinking\.\.\.\n[\s\S]*/g, '');
  cleanText = cleanText.replace(/\{\{screenshot:[a-f0-9-]+\}\}/g, '');
  cleanText = cleanText.replace(/```[\s\S]*?```/g, '');

  const headers: HeaderEntry[] = [];
  const lines = cleanText.split('\n');
  for (const line of lines) {
    const match = line.match(/^(#{1,3})\s+(.+)/);
    if (match) {
      const level = match[1].length as 1 | 2 | 3;
      const headerText = match[2].replace(/<[^>]*>/g, '').trim();
      if (headerText) {
        headers.push({ level, text: headerText });
      }
    }
  }
  return headers;
};

const getPreview = (text: string, maxLength: number = 50): string => {
  let cleanText = text;
  cleanText = cleanText.replace(/(?:<thinking>|思考)([\s\S]*?)(?:<\/thinking>|<\/思考>)/g, '');
  cleanText = cleanText.replace(/Thinking\.\.\.\n[\s\S]*?\n\.\.\.done thinking\./g, '');
  cleanText = cleanText.replace(/Thinking\.\.\.\n[\s\S]*/g, '');
  cleanText = cleanText.replace(/\{\{screenshot:[a-f0-9-]+\}\}/g, '');
  cleanText = cleanText.replace(/<[^>]*>/g, '').replace(/\n/g, ' ').trim();
  if (cleanText.length <= maxLength) return cleanText;
  return cleanText.substring(0, maxLength) + '...';
};

const HEADER_WIDTHS: Record<number, string> = {
  1: 'w-4',
  2: 'w-3',
  3: 'w-2',
};

const HEADER_HOVER_WIDTHS: Record<number, string> = {
  1: 'group-hover:w-5',
  2: 'group-hover:w-4',
  3: 'group-hover:w-3',
};

const HEADER_INDENT: Record<number, string> = {
  1: '',
  2: 'ml-3',
  3: 'ml-6',
};

const HeadersPreview: React.FC<{ headers: HeaderEntry[]; highlightIndex: number; isStreaming?: boolean; previewText?: string }> = ({
  headers,
  highlightIndex,
  isStreaming,
  previewText,
}) => (
  <>
    <div className="flex items-center gap-2">
      <span className={`font-serif text-[0.9rem] ${highlightIndex === -1 ? 'font-semibold text-text-primary' : 'text-text-secondary'}`}>
        Editor
      </span>
    </div>
    {headers.length > 0 ? (
      <div className="flex flex-col gap-0.5 mt-1.5">
        {headers.map((h, i) => (
          <span
            key={i}
            className={`text-[0.75rem] leading-[1.3] ${HEADER_INDENT[h.level]} ${
              i === highlightIndex
                ? 'font-semibold text-text-primary'
                : 'text-text-tertiary'
            }`}
          >
            {h.text}
          </span>
        ))}
      </div>
    ) : (
      <div className="text-xs text-text-tertiary leading-[1.4] overflow-hidden text-ellipsis line-clamp-2 mt-1">
        {isStreaming ? 'Streaming...' : (previewText ?? '')}
      </div>
    )}
  </>
);

const MessageTrail: React.FC<MessageTrailProps> = ({ messages, onScrollToMessage }) => {
  if (messages.length === 0) return null;

  return (
    <div className="w-8 shrink-0 self-start sticky top-0 h-full max-h-full px-1 py-2 flex flex-col justify-center gap-1.5 overflow-y-auto bg-bg-primary">
      {messages.map((message) => {
        if (message.sender === 'assistant') {
          const headers = parseHeaders(message.text);

          return (
            <div
              key={message.id}
              className="flex flex-col group"
              onClick={() => onScrollToMessage(message.id)}
            >
              <div className="flex items-center justify-start min-h-4 cursor-pointer group/msg">
                <div
                  className={`w-5 h-[3px] bg-border-secondary rounded-[1px] transition-all duration-200 ease-in-out relative
                    group-hover:w-6 group-hover/msg:bg-text-tertiary group-hover:bg-text-tertiary`}
                >
                  <div
                    className="fixed right-14 bg-bg-secondary border border-border-secondary rounded-md px-3 py-2
                      min-w-[200px] max-w-[280px] opacity-0 invisible transition-[opacity,visibility] duration-150 ease-in-out
                      shadow-lg z-[100] pointer-events-none
                      group-hover/msg:opacity-100 group-hover/msg:visible"
                  >
                    <HeadersPreview
                      headers={headers}
                      highlightIndex={-1}
                      isStreaming={message.isStreaming}
                      previewText={getPreview(message.text)}
                    />
                  </div>
                </div>
              </div>
              {headers.map((header, idx) => (
                <div
                  key={`${message.id}-h-${idx}`}
                  className="flex items-center justify-start min-h-3 cursor-pointer group/hdr"
                  onClick={(e) => {
                    e.stopPropagation();
                    onScrollToMessage(message.id, idx);
                  }}
                >
                  <div
                    className={`${HEADER_WIDTHS[header.level]} h-[2px] bg-border-secondary rounded-[1px] transition-all duration-200 ease-in-out relative
                      ${HEADER_HOVER_WIDTHS[header.level]} group-hover:bg-text-tertiary group-hover/hdr:bg-text-tertiary`}
                  >
                    <div
                      className="fixed right-14 bg-bg-secondary border border-border-secondary rounded-md px-3 py-2
                        min-w-[200px] max-w-[280px] opacity-0 invisible transition-[opacity,visibility] duration-150 ease-in-out
                        shadow-lg z-[100] pointer-events-none
                        group-hover/hdr:opacity-100 group-hover/hdr:visible"
                    >
                      <HeadersPreview
                        headers={headers}
                        highlightIndex={idx}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          );
        }

        return (
          <div
            key={message.id}
            className="flex items-center justify-end min-h-4 cursor-pointer group"
            onClick={() => onScrollToMessage(message.id)}
          >
            <div
              className={`w-3 h-[3px] bg-border-secondary transition-all duration-200 ease-in-out relative
                rounded-sm
                group-hover:w-4 group-hover:bg-text-tertiary`}
            >
              <div
                className="fixed right-14 bg-bg-secondary border border-border-secondary rounded-md px-3 py-2
                  min-w-[200px] max-w-[280px] opacity-0 invisible transition-[opacity,visibility] duration-150 ease-in-out
                  shadow-lg z-[100] pointer-events-none
                  group-hover:opacity-100 group-hover:visible"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-serif text-[0.9rem] font-medium text-text-primary">Author</span>
                </div>
                <div className="text-xs text-text-tertiary leading-[1.4] overflow-hidden text-ellipsis line-clamp-2">
                  {message.isStreaming ? 'Streaming...' : getPreview(message.text)}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default MessageTrail;