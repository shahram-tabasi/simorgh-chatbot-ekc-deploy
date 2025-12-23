// src/components/MarkdownRenderer.tsx
import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeSanitize from 'rehype-sanitize';
import rehypeRaw from 'rehype-raw';
import 'highlight.js/styles/github-dark.css';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  dir?: 'ltr' | 'rtl';
}

export function MarkdownRenderer({ content, className = '', dir = 'ltr' }: MarkdownRendererProps) {
  return (
    <div
      className={`markdown-content ${className}`}
      dir={dir}
      style={{
        fontSize: '0.875rem',
        lineHeight: '1.6',
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          rehypeRaw,
          rehypeSanitize,
          rehypeHighlight
        ]}
        components={{
          // Headings
          h1: ({ node, ...props }) => (
            <h1 className="text-2xl font-bold mb-4 mt-6 text-white" {...props} />
          ),
          h2: ({ node, ...props }) => (
            <h2 className="text-xl font-bold mb-3 mt-5 text-white" {...props} />
          ),
          h3: ({ node, ...props }) => (
            <h3 className="text-lg font-bold mb-2 mt-4 text-white" {...props} />
          ),
          h4: ({ node, ...props }) => (
            <h4 className="text-base font-bold mb-2 mt-3 text-white" {...props} />
          ),
          h5: ({ node, ...props }) => (
            <h5 className="text-sm font-bold mb-2 mt-3 text-white" {...props} />
          ),
          h6: ({ node, ...props }) => (
            <h6 className="text-xs font-bold mb-2 mt-3 text-white" {...props} />
          ),

          // Paragraphs
          p: ({ node, ...props }) => (
            <p className="mb-3 last:mb-0 leading-relaxed" {...props} />
          ),

          // Lists
          ul: ({ node, ...props }) => (
            <ul className="list-disc list-inside mb-3 space-y-1 ml-4" {...props} />
          ),
          ol: ({ node, ...props }) => (
            <ol className="list-decimal list-inside mb-3 space-y-1 ml-4" {...props} />
          ),
          li: ({ node, ...props }) => (
            <li className="leading-relaxed" {...props} />
          ),

          // Code blocks
          code: ({ node, inline, className, children, ...props }: any) => {
            const match = /language-(\w+)/.exec(className || '');
            return !inline ? (
              <div className="relative my-4 rounded-lg overflow-hidden bg-gray-900 border border-gray-700">
                {match && (
                  <div className="px-4 py-2 bg-gray-800 border-b border-gray-700 text-xs text-gray-400 font-mono">
                    {match[1]}
                  </div>
                )}
                <pre className="p-4 overflow-x-auto">
                  <code className={className} {...props}>
                    {children}
                  </code>
                </pre>
              </div>
            ) : (
              <code
                className="px-1.5 py-0.5 rounded bg-gray-800 text-blue-300 font-mono text-sm border border-gray-700"
                {...props}
              >
                {children}
              </code>
            );
          },

          // Links
          a: ({ node, ...props }) => (
            <a
              className="text-blue-400 hover:text-blue-300 underline transition-colors"
              target="_blank"
              rel="noopener noreferrer"
              {...props}
            />
          ),

          // Blockquotes
          blockquote: ({ node, ...props }) => (
            <blockquote
              className="border-l-4 border-blue-500 pl-4 py-2 my-3 italic bg-white/5 rounded-r"
              {...props}
            />
          ),

          // Tables - Mobile responsive with horizontal scroll container
          table: ({ node, ...props }) => (
            <div className="overflow-x-auto my-4 -mx-3 sm:mx-0 max-w-full">
              {/* Mobile: Scrollable table container with visual hint */}
              <div className="inline-block min-w-full align-middle">
                <div className="overflow-hidden shadow-sm ring-1 ring-gray-700 sm:rounded-lg">
                  <table className="min-w-full divide-y divide-gray-700" {...props} />
                </div>
              </div>
            </div>
          ),
          thead: ({ node, ...props }) => (
            <thead className="bg-gray-800" {...props} />
          ),
          tbody: ({ node, ...props }) => (
            <tbody className="bg-gray-900/50 divide-y divide-gray-700" {...props} />
          ),
          tr: ({ node, ...props }) => (
            <tr {...props} />
          ),
          th: ({ node, ...props }) => (
            // Mobile: smaller padding, responsive text
            <th className="px-2 py-2 sm:px-4 text-left text-xs sm:text-sm font-semibold text-white border-r border-gray-700 last:border-r-0 whitespace-nowrap" {...props} />
          ),
          td: ({ node, ...props }) => (
            // Mobile: smaller padding, allow text wrap on very small content
            <td className="px-2 py-2 sm:px-4 text-xs sm:text-sm border-r border-gray-700 last:border-r-0" {...props} />
          ),

          // Horizontal rule
          hr: ({ node, ...props }) => (
            <hr className="my-4 border-gray-700" {...props} />
          ),

          // Images
          img: ({ node, ...props }) => (
            <img
              className="max-w-full h-auto rounded-lg my-4 border border-gray-700"
              loading="lazy"
              {...props}
            />
          ),

          // Strong/Bold
          strong: ({ node, ...props }) => (
            <strong className="font-bold text-white" {...props} />
          ),

          // Emphasis/Italic
          em: ({ node, ...props }) => (
            <em className="italic" {...props} />
          ),

          // Delete/Strikethrough
          del: ({ node, ...props }) => (
            <del className="line-through opacity-70" {...props} />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
