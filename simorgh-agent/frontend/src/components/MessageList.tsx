import React, { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { UserIcon, SparklesIcon, FileIcon } from 'lucide-react';
import { Message } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';

interface MessageListProps {
  messages: Message[];
  isTyping: boolean;
}

// Helper function to detect if text contains Persian/Arabic characters
function detectTextDirection(text: string): 'rtl' | 'ltr' {
  // Persian/Arabic Unicode ranges
  const persianArabicRegex = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
  return persianArabicRegex.test(text) ? 'rtl' : 'ltr';
}

export function MessageList({ messages, isTyping }: MessageListProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = React.useState(true);

  // Check if user is near bottom of scroll
  const isNearBottom = () => {
    if (!containerRef.current) return true;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    return scrollHeight - scrollTop - clientHeight < 100;
  };

  // Handle scroll events to detect manual scrolling
  const handleScroll = () => {
    setShouldAutoScroll(isNearBottom());
  };

  // Auto-scroll to bottom when new messages arrive (only if user is near bottom)
  useEffect(() => {
    if (shouldAutoScroll && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isTyping, shouldAutoScroll]);

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto px-4 py-6 space-y-6"
      onScroll={handleScroll}
    >
      {messages.map((message, index) => {
        // Detect text direction for this specific message
        const textDir = detectTextDirection(message.content);

        return (
          <motion.div
            key={message.id}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: index * 0.1 }}
            className={`flex gap-4 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            {message.role === 'assistant' && (
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center">
                <SparklesIcon className="w-4 h-4 text-white" />
              </div>
            )}

            <div
              className={`max-w-2xl rounded-2xl px-4 py-3 ${
                message.role === 'user'
                  ? 'bg-gradient-to-br from-blue-500 to-purple-500 text-white'
                  : 'bg-white/5 border border-white/10 text-gray-200'
              }`}
            >
              {message.files && message.files.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {message.files.map((file) => (
                    <div
                      key={file.id}
                      className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-black/20 text-xs"
                    >
                      <FileIcon className="w-3 h-3" />
                      <span className="truncate max-w-[150px]">{file.name}</span>
                    </div>
                  ))}
                </div>
              )}
              {message.role === 'assistant' ? (
                <MarkdownRenderer content={message.content} dir={textDir} />
              ) : (
                <p className="text-sm leading-relaxed whitespace-pre-wrap" dir={textDir}>
                  {message.content}
                </p>
              )}
            </div>

            {message.role === 'user' && (
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-white/10 flex items-center justify-center">
                <UserIcon className="w-4 h-4 text-white" />
              </div>
            )}
          </motion.div>
        );
      })}

      {isTyping && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex gap-4"
        >
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center">
            <SparklesIcon className="w-4 h-4 text-white" />
          </div>
          <div className="bg-white/5 border border-white/10 rounded-2xl px-4 py-3">
            <div className="flex gap-1">
              <div className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '0ms' }} />
              <div className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '150ms' }} />
              <div className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        </motion.div>
      )}

      <div ref={messagesEndRef} />
    </div>
  );
}