import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import markdown from 'highlight.js/lib/languages/markdown';
import xml from 'highlight.js/lib/languages/xml';
import { prepareMarkdownMath } from '../utils/markdownMath';

hljs.registerLanguage('python', python);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('css', css);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);

interface CodeProps {
  node?: unknown;
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
}

interface MarkdownRendererProps {
  content: string;
  highlightTerm?: string;
}

const CopyIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const CheckIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const getCodeText = (children: React.ReactNode): string => (
  String(children).replace(/\n$/, '')
);

const getLanguageFromClassName = (className?: string): string => {
  const match = /language-([\w-]+)/.exec(className || '');
  return match ? match[1] : '';
};

const fencedCodePattern = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
const htmlDocumentPattern = /(^|\n)([ \t]*(?:<!doctype\s+html[^>]*>\s*)?<html\b[\s\S]*?<\/html>)/gi;

const fenceHtmlDocumentsOutsideCode = (value: string): string => {
  let result = '';
  let lastIndex = 0;

  for (const match of value.matchAll(fencedCodePattern)) {
    const matchIndex = match.index ?? 0;
    result += value.slice(lastIndex, matchIndex).replace(
      htmlDocumentPattern,
      (_htmlMatch, prefix: string, html: string) => `${prefix}\`\`\`html\n${html.trimEnd()}\n\`\`\``
    );
    result += match[0];
    lastIndex = matchIndex + match[0].length;
  }

  return result + value.slice(lastIndex).replace(
    htmlDocumentPattern,
    (_htmlMatch, prefix: string, html: string) => `${prefix}\`\`\`html\n${html.trimEnd()}\n\`\`\``
  );
};

const PreBlock: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const [copied, setCopied] = useState(false);
  const child = React.Children.only(children);
  const childProps = React.isValidElement<CodeProps>(child) ? child.props : undefined;
  const code = getCodeText(childProps?.children);
  const language = getLanguageFromClassName(childProps?.className);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [code]);

  return (
    <div className="code-block-shell relative group">
      <button
        type="button"
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1.5 rounded opacity-0 group-hover:opacity-100 transition-opacity text-text-muted hover:text-text-primary hover:bg-bg-primary z-10"
        title={copied ? 'Copied!' : 'Copy code'}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      {language && (
        <div className="absolute top-2 right-10 font-mono text-[0.525rem] text-text-muted uppercase tracking-wider opacity-0 group-hover:opacity-100 transition-opacity">
          {language}
        </div>
      )}
      <pre>{children}</pre>
    </div>
  );
};

const CodeBlock: React.FC<CodeProps> = ({ inline, className, children, ...props }) => {
  const codeRef = useRef<HTMLElement>(null);
  const language = getLanguageFromClassName(className);
  const code = getCodeText(children);

  useEffect(() => {
    if (!inline && codeRef.current && language) {
      delete (codeRef.current as HTMLElement & { dataset: DOMStringMap }).dataset.highlighted;
      hljs.highlightElement(codeRef.current);
    }
  }, [code, language, inline]);

  if (inline) {
    return (
      <code {...props}>
        {children}
      </code>
    );
  }

  return (
    <code ref={codeRef} className={className} {...props}>
      {children}
    </code>
  );
};

const splitHighlightedText = (
  text: string,
  highlightTerm: string,
  keyPrefix: string
): React.ReactNode => {
  const term = highlightTerm.trim();
  if (!term) {
    return text;
  }

  const lowerText = text.toLocaleLowerCase();
  const lowerTerm = term.toLocaleLowerCase();
  const pieces: React.ReactNode[] = [];
  let searchStart = 0;
  let keyIndex = 0;

  while (searchStart < text.length) {
    const matchIndex = lowerText.indexOf(lowerTerm, searchStart);
    if (matchIndex === -1) {
      pieces.push(text.slice(searchStart));
      break;
    }

    if (matchIndex > searchStart) {
      pieces.push(text.slice(searchStart, matchIndex));
    }

    pieces.push(
      <mark key={`${keyPrefix}-${keyIndex}`} className="conversation-search-highlight">
        {text.slice(matchIndex, matchIndex + term.length)}
      </mark>
    );
    keyIndex += 1;
    searchStart = matchIndex + term.length;
  }

  return pieces.length > 0 ? pieces : text;
};

const highlightNode = (
  node: React.ReactNode,
  highlightTerm: string,
  keyPrefix = 'highlight'
): React.ReactNode => {
  if (!highlightTerm.trim()) {
    return node;
  }

  if (typeof node === 'string') {
    return splitHighlightedText(node, highlightTerm, keyPrefix);
  }

  if (typeof node === 'number') {
    return splitHighlightedText(String(node), highlightTerm, keyPrefix);
  }

  if (Array.isArray(node)) {
    return node.map((child, index) => highlightNode(child, highlightTerm, `${keyPrefix}-${index}`));
  }

  if (!React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return node;
  }

  if (
    node.type === CodeBlock
    || node.type === PreBlock
    || node.type === 'code'
    || node.type === 'mark'
    || node.type === 'pre'
  ) {
    return node;
  }

  const children = node.props.children;
  if (children === undefined || children === null) {
    return node;
  }

  return React.cloneElement(
    node,
    undefined,
    highlightNode(children, highlightTerm, `${keyPrefix}-child`)
  );
};

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content, highlightTerm = '' }) => {
  const normalizedContent = prepareMarkdownMath(fenceHtmlDocumentsOutsideCode(content));
  const highlight = useCallback((children: React.ReactNode) => (
    highlightNode(children, highlightTerm)
  ), [highlightTerm]);

  return (
    <div className="marktext-content markdown-content text-text-primary">
      <ReactMarkdown
        remarkPlugins={[[remarkMath, { singleDollarTextMath: true }], [remarkGfm, { singleTilde: false }]]}
        rehypePlugins={[rehypeKatex]}
        components={{
          pre: PreBlock,
          code: CodeBlock,
          h1: ({ children }) => <h1>{highlight(children)}</h1>,
          h2: ({ children }) => <h2>{highlight(children)}</h2>,
          h3: ({ children }) => <h3>{highlight(children)}</h3>,
          h4: ({ children }) => <h4>{highlight(children)}</h4>,
          h5: ({ children }) => <h5>{highlight(children)}</h5>,
          h6: ({ children }) => <h6>{highlight(children)}</h6>,
          p: ({ children }) => <p>{highlight(children)}</p>,
          ul: ({ children }) => <ul>{highlight(children)}</ul>,
          ol: ({ children }) => <ol>{highlight(children)}</ol>,
          li: ({ children }) => <li>{highlight(children)}</li>,
          blockquote: ({ children }) => (
            <blockquote>
              {highlight(children)}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {highlight(children)}
            </a>
          ),
          strong: ({ children }) => <strong>{highlight(children)}</strong>,
          em: ({ children }) => <em>{highlight(children)}</em>,
          hr: () => <hr />,
          table: ({ children }) => (
            <div className="table-scroll">
              <table>
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => <thead>{highlight(children)}</thead>,
          tbody: ({ children }) => <tbody>{highlight(children)}</tbody>,
          tr: ({ children }) => <tr>{highlight(children)}</tr>,
          th: ({ children }) => <th>{highlight(children)}</th>,
          td: ({ children }) => <td>{highlight(children)}</td>,
          img: ({ src, alt }) => <img src={src} alt={alt ?? ''} loading="lazy" />,
        }}
      >
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
};

export default React.memo(MarkdownRenderer);
