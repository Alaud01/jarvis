import React, { useEffect, useRef } from 'react';
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

hljs.registerLanguage('python', python);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('css', css);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('markdown', markdown);

interface CodeProps {
  node?: any;
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
}

interface MarkdownRendererProps {
  content: string;
}

const CodeBlock: React.FC<CodeProps> = ({ inline, className, children, ...props }) => {
  const codeRef = useRef<HTMLElement>(null);
  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : '';
  const code = String(children).replace(/\n$/, '');

  useEffect(() => {
    if (!inline && codeRef.current && language) {
      delete (codeRef.current as any).dataset.highlighted;
      hljs.highlightElement(codeRef.current);
    }
  }, [code, language, inline]);

  if (inline) {
    return (
      <code className="bg-bg-code px-1 py-0.5 rounded text-sm font-mono" {...props}>
        {children}
      </code>
    );
  }

  return (
    <div className="relative group my-4">
      {language && (
        <div className="absolute top-2 right-2 font-mono text-[0.65rem] text-text-muted uppercase tracking-wider opacity-0 group-hover:opacity-100 transition-opacity">
          {language}
        </div>
      )}
      <pre className="bg-bg-code border border-border-primary rounded overflow-x-auto">
        <code ref={codeRef} className={`language-${language} font-mono text-sm`} {...props}>
          {children}
        </code>
      </pre>
    </div>
  );
};

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content }) => {
  return (
    <div className="markdown-content text-text-primary leading-relaxed">
      <style>{`
        .markdown-content ul, .markdown-content ol { padding-left: 1.5rem; margin-top: 0; margin-bottom: 1rem; }
        .markdown-content ul { list-style-type: disc; }
        .markdown-content ol { list-style-type: decimal; }
        .markdown-content li { margin-top: 0.25rem; }
        .markdown-content li > p { margin-top: 1rem; margin-bottom: 0; }
        .markdown-content li > p:first-child { margin-top: 0; }
        .markdown-content li > ul, .markdown-content li > ol { margin-top: 0.25rem; margin-bottom: 0; }
        .markdown-content ul ul { list-style-type: circle; }
        .markdown-content ul ul ul { list-style-type: lower-roman; }
        .markdown-content ol ol { list-style-type: lower-alpha; }
        .markdown-content ol ol ol { list-style-type: lower-roman; }
      `}</style>
      <ReactMarkdown
        remarkPlugins={[remarkMath, remarkGfm]}
        rehypePlugins={[rehypeKatex]}
        components={{
          code: CodeBlock,
          h1: ({ children }) => <h1 className="text-2xl font-serif font-bold mt-6 mb-4">{children}</h1>,
          h2: ({ children }) => <h2 className="text-xl font-serif font-bold mt-5 mb-3">{children}</h2>,
          h3: ({ children }) => <h3 className="text-lg font-serif font-bold mt-4 mb-2">{children}</h3>,
          p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="mb-3">{children}</ul>,
          ol: ({ children }) => <ol className="mb-3">{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-text-muted pl-4 italic my-4 text-text-secondary">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a href={href} className="text-text-primary underline hover:opacity-80" target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          hr: () => <hr className="my-6 border-t border-border-secondary" />,
          table: ({ children }) => (
            <div className="my-4 overflow-x-auto">
              <table className="min-w-full border-collapse border border-border-secondary">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-bg-secondary">{children}</thead>,
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => <tr className="border-b border-border-secondary">{children}</tr>,
          th: ({ children }) => (
            <th className="border border-border-secondary px-4 py-2 text-left font-bold font-serif">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-border-secondary px-4 py-2">
              {children}
            </td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};

export default MarkdownRenderer;