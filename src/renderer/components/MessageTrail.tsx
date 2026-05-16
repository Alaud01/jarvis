import React, { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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

const MAX_PREVIEW_HEADERS = 9;

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

const getPreviewHeaders = (headers: HeaderEntry[]): HeaderEntry[] => {
  if (headers.length <= MAX_PREVIEW_HEADERS) {
    return headers;
  }

  for (const maxLevel of [2, 1] as const) {
    const filteredHeaders = headers.filter((header) => header.level <= maxLevel);
    if (filteredHeaders.length <= MAX_PREVIEW_HEADERS) {
      return filteredHeaders;
    }
  }

  return headers.filter((header) => header.level === 1).slice(0, MAX_PREVIEW_HEADERS);
};

const getSourceHeaderIndex = (headers: HeaderEntry[], targetHeader: HeaderEntry): number => {
  return headers.findIndex((header) => header === targetHeader);
};

const getHighlightedPreviewIndex = (headers: HeaderEntry[], previewHeaders: HeaderEntry[], highlightIndex: number): number => {
  if (highlightIndex < 0) {
    return -1;
  }

  const highlightedHeader = headers[highlightIndex];
  return highlightedHeader ? previewHeaders.indexOf(highlightedHeader) : -1;
};

const getPreview = (text: string, maxLength: number = 120): string => {
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

const InlineMarkdownPreview: React.FC<{ content: string; className?: string }> = ({ content, className = '' }) => (
  <span className={`trail-markdown-preview ${className}`}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <span>{children}</span>,
        strong: ({ children }) => <strong>{children}</strong>,
        em: ({ children }) => <em>{children}</em>,
        code: ({ children }) => <code>{children}</code>,
        a: ({ children }) => <span>{children}</span>,
        del: ({ children }) => <del>{children}</del>,
        br: () => <span> </span>,
        ul: ({ children }) => <span>{children}</span>,
        ol: ({ children }) => <span>{children}</span>,
        li: ({ children }) => <span>{children}</span>,
      }}
    >
      {content}
    </ReactMarkdown>
  </span>
);

const HeadersPreview: React.FC<{ headers: HeaderEntry[]; previewHeaders: HeaderEntry[]; highlightIndex: number; isStreaming?: boolean; previewText?: string }> = ({
  headers,
  previewHeaders,
  highlightIndex,
  isStreaming,
  previewText,
}) => {
  const highlightedPreviewIndex = getHighlightedPreviewIndex(headers, previewHeaders, highlightIndex);

  return (
    <>
      <div className="flex items-center gap-2">
        <span className={`font-serif text-[0.9rem] ${highlightedPreviewIndex === -1 ? 'text-text-primary' : 'text-text-secondary'}`}>
          Jarvis
        </span>
      </div>
      {previewHeaders.length > 0 ? (
        <div className="flex flex-col gap-1 mt-1.5">
          {previewHeaders.map((h, i) => (
            <span
              key={getSourceHeaderIndex(headers, h)}
              className={`block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[0.75rem] leading-[1.3] ${HEADER_INDENT[h.level]} ${
                i === highlightedPreviewIndex
                  ? 'text-text-primary'
                  : 'text-text-tertiary'
              }`}
            >
              <InlineMarkdownPreview content={h.text} />
            </span>
          ))}
        </div>
      ) : (
        <div className="text-xs text-text-tertiary leading-[1.4] overflow-hidden text-ellipsis line-clamp-2 mt-1">
          {isStreaming ? 'Streaming...' : <InlineMarkdownPreview content={previewText ?? ''} />}
        </div>
      )}
    </>
  );
};

interface AssistantTrailItemProps {
  message: Message;
  onScrollToMessage: (messageId: string, headerIndex?: number) => void;
}

const AssistantTrailItem: React.FC<AssistantTrailItemProps> = ({ message, onScrollToMessage }) => {
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const headers = useMemo(() => parseHeaders(message.text), [message.text]);
  const previewHeaders = useMemo(() => getPreviewHeaders(headers), [headers]);
  const previewText = useMemo(() => getPreview(message.text), [message.text]);

  return (
    <div
      className="flex flex-col group"
      onClick={() => onScrollToMessage(message.id)}
      onMouseEnter={() => setHighlightIndex(-1)}
      onMouseLeave={() => setHighlightIndex(-1)}
    >
      <div
        className="fixed right-14 bg-bg-secondary border border-border-secondary rounded-md px-3 py-2
          min-w-[200px] max-w-[280px] opacity-0 invisible transition-[opacity,visibility] duration-150 ease-in-out
          shadow-lg z-[100] pointer-events-none
          group-hover:opacity-100 group-hover:visible"
      >
        <HeadersPreview
          headers={headers}
          previewHeaders={previewHeaders}
          highlightIndex={highlightIndex}
          isStreaming={message.isStreaming}
          previewText={previewText}
        />
      </div>

      <div
        className="flex items-center justify-start min-h-4 cursor-pointer group/msg"
        onMouseEnter={() => setHighlightIndex(-1)}
      >
        <div
          className={`w-5 h-[3px] bg-border-secondary rounded-[1px] transition-all duration-200 ease-in-out
            group-hover:w-6 group-hover/msg:bg-text-tertiary group-hover:bg-text-tertiary`}
        />
      </div>
      {previewHeaders.map((header) => {
        const sourceHeaderIndex = getSourceHeaderIndex(headers, header);

        return (
        <div
          key={`${message.id}-h-${sourceHeaderIndex}`}
          className="flex items-center justify-start min-h-3 cursor-pointer group/hdr"
          onMouseEnter={() => setHighlightIndex(sourceHeaderIndex)}
          onClick={(e) => {
            e.stopPropagation();
            onScrollToMessage(message.id, sourceHeaderIndex);
          }}
        >
          <div
            className={`${HEADER_WIDTHS[header.level]} h-[2px] bg-border-secondary rounded-[1px] transition-all duration-200 ease-in-out
              ${HEADER_HOVER_WIDTHS[header.level]} group-hover:bg-text-tertiary group-hover/hdr:bg-text-tertiary`}
          />
        </div>
        );
      })}
    </div>
  );
};

const MessageTrail: React.FC<MessageTrailProps> = ({ messages, onScrollToMessage }) => {
  if (messages.length === 0) return null;

  return (
    <div className="w-8 shrink-0 self-start sticky top-0 h-full max-h-full px-1 py-2 flex flex-col justify-center gap-1.5 overflow-y-auto bg-bg-primary">
      {messages.map((message) => {
        if (message.sender === 'assistant') {
          return (
            <AssistantTrailItem
              key={message.id}
              message={message}
              onScrollToMessage={onScrollToMessage}
            />
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
                  {message.isStreaming ? 'Streaming...' : <InlineMarkdownPreview content={getPreview(message.text)} />}
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
