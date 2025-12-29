import React, { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  UserIcon,
  SparklesIcon,
  FileIcon,
  ThumbsUpIcon,
  ThumbsDownIcon,
  CopyIcon,
  RefreshCwIcon,
  Share2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Edit2Icon
} from 'lucide-react';
import { Message } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';

interface MessageListProps {
  messages: Message[];
  isTyping: boolean;
  onRegenerateResponse?: (messageId: string) => void;
  onUpdateReaction?: (messageId: string, reaction: 'like' | 'dislike' | 'none') => void;
  onSwitchVersion?: (messageId: string, versionIndex: number) => void;
  onEditMessage?: (message: Message) => void;
}

// Helper function to detect if text contains Persian/Arabic characters
function detectTextDirection(text: string): 'rtl' | 'ltr' {
  // Persian/Arabic Unicode ranges
  const persianArabicRegex = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
  return persianArabicRegex.test(text) ? 'rtl' : 'ltr';
}

// Format timestamp for display (Telegram/WhatsApp style)
function formatTimestamp(timestamp: Date | string): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  // Just now (< 1 minute)
  if (diffMins < 1) return 'Just now';

  // X minutes ago (< 60 minutes)
  if (diffMins < 60) return `${diffMins} min ago`;

  // Today: show time only
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  // Yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `Yesterday ${hours}:${minutes}`;
  }

  // Older: show full date
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const year = date.getFullYear();
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${day}/${month}/${year} ${hours}:${minutes}`;
}

export function MessageList({
  messages,
  isTyping,
  onRegenerateResponse,
  onUpdateReaction,
  onSwitchVersion,
  onEditMessage
}: MessageListProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = React.useState(true);
  const [showCopyConfirmation, setShowCopyConfirmation] = React.useState(false);
  const scrollAnimationRef = useRef<number | null>(null);
  const lastMessageCountRef = useRef(messages.length);

  // Check if any message is currently streaming
  const isStreaming = React.useMemo(() => {
    return messages.some(msg => msg.metadata?.streaming === true);
  }, [messages]);

  // Log API capabilities once on mount (dev-safe detection)
  React.useEffect(() => {
    const hasShareAPI = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
    const hasClipboardAPI = typeof navigator !== 'undefined' &&
                           navigator.clipboard &&
                           typeof navigator.clipboard.writeText === 'function';

    console.log('🔍 Browser API Detection:', {
      shareAPI: hasShareAPI,
      clipboardAPI: hasClipboardAPI,
      navigatorExists: typeof navigator !== 'undefined',
      clipboardExists: typeof navigator !== 'undefined' ? navigator.clipboard !== undefined : false,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'N/A'
    });

    if (!hasClipboardAPI) {
      console.warn('⚠️ Clipboard API unavailable - will use textarea fallback for copy operations');
    }
  }, []);

  // Copy message content to clipboard - BULLETPROOF with fallback
  const handleCopy = async (content: string) => {
    // Verify content is not empty
    if (!content || content.trim().length === 0) {
      console.error('❌ Copy failed: content is empty');
      return;
    }

    console.log('📋 Copying content (length:', content.length, ')');

    // CRITICAL: Check if Clipboard API exists before trying to use it
    const hasClipboardAPI = typeof navigator !== 'undefined' &&
                           navigator.clipboard &&
                           typeof navigator.clipboard.writeText === 'function';

    console.log('📋 Clipboard API available?', hasClipboardAPI);

    if (hasClipboardAPI) {
      // Try modern Clipboard API if available
      try {
        await navigator.clipboard.writeText(content);
        console.log('✅ Content copied via Clipboard API');
        setShowCopyConfirmation(true);
        setTimeout(() => setShowCopyConfirmation(false), 2000);
        return;
      } catch (clipboardError) {
        console.warn('⚠️ Clipboard API call failed, using fallback:', clipboardError);
        // Fall through to textarea fallback
      }
    } else {
      console.log('ℹ️ Clipboard API not available, using textarea fallback');
    }

    // Fallback: textarea + execCommand (works even if Clipboard API undefined)
    try {
      const textarea = document.createElement('textarea');
      textarea.value = content;
      textarea.style.position = 'fixed';
      textarea.style.left = '-999999px';
      textarea.style.top = '-999999px';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();

      const successful = document.execCommand('copy');
      document.body.removeChild(textarea);

      if (successful) {
        console.log('✅ Content copied via execCommand fallback');
        setShowCopyConfirmation(true);
        setTimeout(() => setShowCopyConfirmation(false), 2000);
      } else {
        console.error('❌ execCommand copy failed');
      }
    } catch (fallbackError) {
      console.error('❌ All copy methods failed:', fallbackError);
    }
  };

  // Share message using Web Share API - MUST check properly for function type
  const handleShare = async (content: string) => {
    // Verify content is not empty
    if (!content || content.trim().length === 0) {
      console.error('❌ Share failed: content is empty');
      return;
    }

    console.log('📤 SHARE CLICKED - Content length:', content.length);

    // CRITICAL: Proper detection - check navigator exists AND share is a function
    const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
    console.log('📤 Can use Web Share API?', canShare);

    if (canShare) {
      // Web Share API is available - use it
      console.log('📤 Calling navigator.share() directly...');
      try {
        await navigator.share({
          text: content
        });
        console.log('✅ Share completed - user selected an app');
        // NO fallback to copy - share succeeded
        return;
      } catch (shareError: any) {
        console.log('⚠️ Share error:', shareError.name, '-', shareError.message);

        // User cancelled - this is normal, don't fall back
        if (shareError.name === 'AbortError') {
          console.log('ℹ️ User cancelled share (normal behavior, no fallback)');
          return;
        }

        // Real error - log it and fall back
        console.error('❌ Share failed with error (falling back to copy):', shareError);
        await handleCopy(content);
      }
    } else {
      // Web Share API not supported - fall back to copy
      console.log('ℹ️ Web Share API not supported - falling back to copy');
      console.log('   navigator exists:', typeof navigator !== 'undefined');
      console.log('   navigator.share is function:', typeof navigator !== 'undefined' && typeof navigator.share === 'function');
      await handleCopy(content);
    }
  };

  // Handle reaction (like/dislike)
  const handleReaction = (messageId: string, currentReaction: 'like' | 'dislike' | 'none', newReaction: 'like' | 'dislike') => {
    if (!onUpdateReaction) return;

    // Toggle off if clicking the same reaction
    if (currentReaction === newReaction) {
      onUpdateReaction(messageId, 'none');
    } else {
      onUpdateReaction(messageId, newReaction);
    }
  };

  // Check if user is near bottom of scroll
  const isNearBottom = React.useCallback(() => {
    if (!containerRef.current) return true;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    return scrollHeight - scrollTop - clientHeight < 150;
  }, []);

  // Handle scroll events to detect manual scrolling
  const handleScroll = React.useCallback(() => {
    setShouldAutoScroll(isNearBottom());
  }, [isNearBottom]);

  // Smooth scroll to bottom using requestAnimationFrame
  const scrollToBottom = React.useCallback((instant: boolean = false) => {
    if (!containerRef.current) return;

    // Cancel any ongoing scroll animation
    if (scrollAnimationRef.current) {
      cancelAnimationFrame(scrollAnimationRef.current);
      scrollAnimationRef.current = null;
    }

    const container = containerRef.current;
    const targetScroll = container.scrollHeight - container.clientHeight;

    if (instant || isStreaming) {
      // Instant scroll for streaming content (prevents jank)
      container.scrollTop = targetScroll;
    } else {
      // Smooth scroll for new messages
      const startScroll = container.scrollTop;
      const distance = targetScroll - startScroll;
      const duration = 200; // ms
      const startTime = performance.now();

      const animateScroll = (currentTime: number) => {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        // Ease out function
        const easeOut = 1 - Math.pow(1 - progress, 3);
        container.scrollTop = startScroll + distance * easeOut;

        if (progress < 1) {
          scrollAnimationRef.current = requestAnimationFrame(animateScroll);
        } else {
          scrollAnimationRef.current = null;
        }
      };

      scrollAnimationRef.current = requestAnimationFrame(animateScroll);
    }
  }, [isStreaming]);

  // Auto-scroll when messages change
  useEffect(() => {
    const newMessageAdded = messages.length > lastMessageCountRef.current;
    lastMessageCountRef.current = messages.length;

    if (shouldAutoScroll) {
      // Use instant scroll during streaming, smooth for new messages
      scrollToBottom(isStreaming);
    }
  }, [messages, shouldAutoScroll, scrollToBottom, isStreaming]);

  // Also scroll when typing indicator appears
  useEffect(() => {
    if (isTyping && shouldAutoScroll) {
      scrollToBottom(false);
    }
  }, [isTyping, shouldAutoScroll, scrollToBottom]);

  // Cleanup animation on unmount
  useEffect(() => {
    return () => {
      if (scrollAnimationRef.current) {
        cancelAnimationFrame(scrollAnimationRef.current);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      // Mobile: ensure scrollable messages with proper spacing
      className="flex-1 overflow-y-auto overflow-x-hidden px-2 sm:px-4 py-4 sm:py-6 space-y-4 sm:space-y-6"
      onScroll={handleScroll}
    >
      {messages.map((message, index) => {
        // Detect text direction for this specific message
        const textDir = detectTextDirection(message.content);

        return (
          <motion.div
            key={message.id}
            initial={{ opacity: 1, y: 0 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0 }}
            // Mobile: reduce gap and ensure proper layout
            className={`flex gap-2 sm:gap-4 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            {message.role === 'assistant' && (
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center">
                <SparklesIcon className="w-4 h-4 text-white" />
              </div>
            )}

            <div className="flex flex-col gap-1 min-w-0">
              <div
                // Mobile: smaller max-width, ensure text wraps properly
                className={`max-w-[85vw] sm:max-w-xl md:max-w-2xl rounded-2xl px-3 sm:px-4 py-3 break-words overflow-wrap-anywhere ${
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
                  // Mobile: ensure user messages wrap and don't overflow
                  <p className="text-sm leading-relaxed whitespace-pre-wrap break-words" dir={textDir}>
                    {message.content}
                  </p>
                )}
              </div>

              {/* AI Message Controls */}
              {message.role === 'assistant' && (
                <div className="flex items-center gap-1 px-2 mt-1">
                  {/* Like/Dislike */}
                  <button
                    onClick={() => handleReaction(
                      message.id,
                      message.liked ? 'like' : message.disliked ? 'dislike' : 'none',
                      'like'
                    )}
                    className={`p-1.5 rounded-lg hover:bg-white/10 transition-colors ${
                      message.liked ? 'text-blue-400 bg-blue-400/10' : 'text-gray-400'
                    }`}
                    title="Like this response"
                  >
                    <ThumbsUpIcon className="w-3.5 h-3.5" />
                  </button>

                  <button
                    onClick={() => handleReaction(
                      message.id,
                      message.liked ? 'like' : message.disliked ? 'dislike' : 'none',
                      'dislike'
                    )}
                    className={`p-1.5 rounded-lg hover:bg-white/10 transition-colors ${
                      message.disliked ? 'text-red-400 bg-red-400/10' : 'text-gray-400'
                    }`}
                    title="Dislike this response"
                  >
                    <ThumbsDownIcon className="w-3.5 h-3.5" />
                  </button>

                  <div className="w-px h-4 bg-white/10 mx-0.5" />

                  {/* Copy */}
                  <button
                    onClick={() => handleCopy(message.content)}
                    className="p-1.5 rounded-lg hover:bg-white/10 transition-colors text-gray-400"
                    title="Copy response"
                  >
                    <CopyIcon className="w-3.5 h-3.5" />
                  </button>

                  {/* Regenerate */}
                  <button
                    onClick={() => onRegenerateResponse?.(message.id)}
                    className="p-1.5 rounded-lg hover:bg-white/10 transition-colors text-gray-400 relative"
                    title="Regenerate response"
                  >
                    <RefreshCwIcon className="w-3.5 h-3.5" />
                    {message.refreshCount && message.refreshCount > 0 && (
                      <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-blue-500 text-white text-[9px] font-bold flex items-center justify-center">
                        {message.refreshCount}
                      </span>
                    )}
                  </button>

                  {/* Share */}
                  <button
                    onClick={() => handleShare(message.content)}
                    className="p-1.5 rounded-lg hover:bg-white/10 transition-colors text-gray-400"
                    title="Share response"
                  >
                    <Share2Icon className="w-3.5 h-3.5" />
                  </button>

                  {/* Version Navigator */}
                  {message.versions && message.versions.length > 0 && (
                    <>
                      <div className="w-px h-4 bg-white/10 mx-0.5" />
                      <button
                        onClick={() => {
                          const currentIdx = message.currentVersionIndex ?? message.versions!.length;
                          if (currentIdx > 0) {
                            onSwitchVersion?.(message.id, currentIdx - 1);
                          }
                        }}
                        disabled={!message.currentVersionIndex || message.currentVersionIndex === 0}
                        className="p-1.5 rounded-lg hover:bg-white/10 transition-colors text-gray-400 disabled:opacity-30 disabled:cursor-not-allowed"
                        title="Previous version"
                      >
                        <ChevronLeftIcon className="w-3.5 h-3.5" />
                      </button>
                      <span className="text-xs text-gray-500 px-1">
                        {(message.currentVersionIndex ?? message.versions.length) + 1}/{message.versions.length + 1}
                      </span>
                      <button
                        onClick={() => {
                          const currentIdx = message.currentVersionIndex ?? message.versions!.length;
                          if (currentIdx < message.versions!.length) {
                            onSwitchVersion?.(message.id, currentIdx + 1);
                          }
                        }}
                        disabled={message.currentVersionIndex === message.versions.length}
                        className="p-1.5 rounded-lg hover:bg-white/10 transition-colors text-gray-400 disabled:opacity-30 disabled:cursor-not-allowed"
                        title="Next version"
                      >
                        <ChevronRightIcon className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </div>
              )}

              {/* User Message Controls - Copy and Edit only (NO Share) */}
              {message.role === 'user' && (
                <div className="flex items-center gap-1 px-2 mt-1 justify-end">
                  {/* Copy button for user messages */}
                  <button
                    onClick={() => handleCopy(message.content)}
                    className="p-1.5 rounded-lg hover:bg-white/10 transition-colors text-gray-400"
                    title="Copy message"
                  >
                    <CopyIcon className="w-3.5 h-3.5" />
                  </button>

                  {/* Edit button only for last user message */}
                  {index === messages.length - (isTyping ? 2 : 1) && (
                    <button
                      onClick={() => onEditMessage?.(message)}
                      className="p-1.5 rounded-lg hover:bg-white/10 transition-colors text-gray-400"
                      title="Edit message"
                    >
                      <Edit2Icon className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )}

              {/* Timestamp */}
              {message.timestamp && (
                <span
                  className={`text-xs text-gray-500 px-2 ${
                    message.role === 'user' ? 'text-right' : 'text-left'
                  }`}
                >
                  {formatTimestamp(message.timestamp)}
                </span>
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
          initial={{ opacity: 1, y: 0 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0 }}
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

      {/* Copy confirmation message */}
      {showCopyConfirmation && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-green-500 text-white text-sm rounded-lg shadow-lg animate-fade-in">
          Copied to clipboard
        </div>
      )}
    </div>
  );
}