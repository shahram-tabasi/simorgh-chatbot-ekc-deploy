import React, { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  SparklesIcon,
  FileIcon,
  ThumbsUpIcon,
  ThumbsDownIcon,
  CopyIcon,
  RefreshCwIcon,
  Share2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Edit2Icon,
  Volume2Icon,
  LoaderIcon,
  SquareIcon
} from 'lucide-react';
import { Message } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { showError } from '../utils/alerts';
import { useAuth, isModernUser, isLegacyUser } from '../context/AuthContext';
import { loadStoredAvatar, presetAvatarUrl } from './AvatarPicker';
import {
  ProcessingActivity,
  generateProcessingSteps,
  progressSteps,
} from './ProcessingActivity';
import { AgentTaskStream } from './AgentTaskStream';

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

/**
 * TypingActivityIndicator - replaces the basic bouncing dots with
 * a collapsible processing activity panel showing what the AI is doing.
 */
function TypingActivityIndicator({ messages }: { messages: Message[] }) {
  // Determine if the last user message had files
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const hasFiles = !!(lastUserMsg?.files && lastUserMsg.files.length > 0);
  const hasDocCategory = lastUserMsg?.files?.some((f) => f.category === 'document');

  // Generate steps once, then progress them over time
  const stepsRef = React.useRef(generateProcessingSteps(hasFiles, hasDocCategory));
  const startTimeRef = React.useRef(Date.now());
  const [currentSteps, setCurrentSteps] = React.useState(stepsRef.current);

  React.useEffect(() => {
    stepsRef.current = generateProcessingSteps(hasFiles, hasDocCategory);
    startTimeRef.current = Date.now();
    setCurrentSteps(stepsRef.current);

    const interval = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      setCurrentSteps(progressSteps(stepsRef.current, elapsed, false, false));
    }, 600);

    return () => clearInterval(interval);
  }, [hasFiles, hasDocCategory]);

  const activeStep = currentSteps.find((s) => s.status === 'active');

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
    >
      <ProcessingActivity
        steps={currentSteps}
        title={activeStep?.label || 'Processing...'}
        isComplete={false}
      />
    </motion.div>
  );
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
  const [speakingMessageId, setSpeakingMessageId] = React.useState<string | null>(null);
  const [speechLoading, setSpeechLoading] = React.useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Resolve the current user's chosen avatar (preset SVG or uploaded
  // image) from localStorage so the user bubble shows their picture
  // instead of the generic person glyph. Re-derives on the same
  // `simorgh-avatar-changed` CustomEvent the SettingsPanel listens to.
  const { user } = useAuth();
  const avatarUserId = user
    ? isModernUser(user)
      ? (user.id as string)
      : isLegacyUser(user)
        ? user.EMPUSERNAME
        : null
    : null;
  const avatarInitial = (
    (user && isModernUser(user) && (user.display_name || user.first_name || user.email)) ||
    (user && isLegacyUser(user) && user.EMPUSERNAME) ||
    'U'
  ).trim().charAt(0).toUpperCase();
  const [userAvatarUrl, setUserAvatarUrl] = React.useState<string>(() =>
    loadStoredAvatar(avatarUserId, avatarInitial) || presetAvatarUrl('indigo', avatarInitial)
  );
  React.useEffect(() => {
    setUserAvatarUrl(loadStoredAvatar(avatarUserId, avatarInitial) || presetAvatarUrl('indigo', avatarInitial));
    const onChange = () => {
      setUserAvatarUrl(loadStoredAvatar(avatarUserId, avatarInitial) || presetAvatarUrl('indigo', avatarInitial));
    };
    window.addEventListener('simorgh-avatar-changed', onChange);
    return () => window.removeEventListener('simorgh-avatar-changed', onChange);
  }, [avatarUserId, avatarInitial]);
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

  // Text-to-Speech: synthesize and play audio for a message
  const handleSpeak = async (messageId: string, content: string) => {
    // If already speaking this message, stop it
    if (speakingMessageId === messageId) {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
        audioRef.current = null;
      }
      setSpeakingMessageId(null);
      return;
    }

    // Stop any currently playing audio
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }

    if (!content || content.trim().length === 0) return;

    setSpeechLoading(messageId);

    try {
      // Strip markdown for cleaner speech
      const plainText = content
        .replace(/```[\s\S]*?```/g, '') // remove code blocks
        .replace(/`[^`]+`/g, '') // remove inline code
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links to text
        .replace(/[#*_~>|]/g, '') // remove markdown symbols
        .replace(/\n{2,}/g, '. ') // paragraph breaks to periods
        .replace(/\n/g, ' ') // newlines to spaces
        .trim();

      // Detect language for voice selection
      const persianArabicRegex = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
      const voice = persianArabicRegex.test(plainText) ? 'fa-female' : 'en-male';

      const response = await fetch('/api/tts/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: plainText.substring(0, 5000), // Limit text length
          voice: voice,
          rate: '+0%',
          volume: '+0%'
        }),
      });

      if (!response.ok) {
        // tts-service returns 503 with a structured body
        // ({error_code, user_message_fa, user_message_en, ...}) when the
        // upstream speech provider is unreachable. Surface that to the
        // user instead of silently failing — see the matching backend
        // path in tts-service/app.py.
        let userMessage: string | null = null;
        try {
          const errBody = await response.json();
          // Prefer the Persian message when the rendered reply is in
          // Persian script (same regex used to pick the voice above),
          // else fall back to English. Backend always provides both.
          userMessage = (persianArabicRegex.test(plainText)
            ? errBody?.user_message_fa
            : errBody?.user_message_en) ?? null;
        } catch {
          /* response wasn't JSON — fall through to the generic toast */
        }
        const isPersian = persianArabicRegex.test(plainText);
        showError(
          isPersian ? 'پخش صدا ممکن نشد' : 'Voice playback failed',
          userMessage
            ?? (isPersian
              ? 'در حال حاضر امکان پخش صوتی پاسخ وجود ندارد. لطفاً بعداً دوباره تلاش کنید.'
              : 'Could not play the spoken reply right now. Please try again later.')
        );
        throw new Error(`TTS failed: ${response.status}`);
      }

      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);

      audio.onended = () => {
        setSpeakingMessageId(null);
        URL.revokeObjectURL(audioUrl);
        audioRef.current = null;
      };

      audio.onerror = () => {
        setSpeakingMessageId(null);
        URL.revokeObjectURL(audioUrl);
        audioRef.current = null;
        console.error('Audio playback failed');
      };

      audioRef.current = audio;
      setSpeechLoading(null);
      setSpeakingMessageId(messageId);
      await audio.play();
    } catch (error) {
      console.error('TTS error:', error);
      setSpeechLoading(null);
      setSpeakingMessageId(null);
    }
  };

  // Cleanup audio on unmount
  React.useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

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

  // Auto-scroll only when a brand-new message is appended — NOT on
  // every streaming chunk. Previously the effect re-ran on the full
  // `messages` array reference (which changes on each SSE chunk) and
  // kept yanking the viewport downward as text was being typed,
  // making the reply visibly "crawl upward" while the operator was
  // mid-read. By depending on length alone and scrolling once per
  // new message, the content now grows downward in-place and the
  // user can read at their own pace.
  useEffect(() => {
    const newMessageAdded = messages.length > lastMessageCountRef.current;
    lastMessageCountRef.current = messages.length;

    if (newMessageAdded && shouldAutoScroll) {
      scrollToBottom(false);
    }
  }, [messages.length, shouldAutoScroll, scrollToBottom]);

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
              // Bare Simorgh mark — no circle, no scale.
              // Uses favicon.svg (square viewBox) instead of simorgh.svg
              // — the latter is a 3:2 wordmark-style asset whose bird
              // sits in the upper portion of its viewBox, so in a
              // square avatar slot the tail was getting clipped.
              <div className="flex-shrink-0 w-10 h-10 sm:w-11 sm:h-11 flex items-center justify-center">
                <img
                  src={`${import.meta.env.BASE_URL}favicon.svg`}
                  alt="Simorgh"
                  className="w-full h-full object-contain"
                  style={{
                    filter: 'drop-shadow(0 0 6px rgba(96,165,250,0.35))',
                  }}
                />
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
                {/* Phase 5 — CoT plan chip. Surfaces the master
                    router's per-turn decision. Color-coded by plan
                    family so the operator can spot at a glance which
                    strategy each reply used. */}
                {message.role === 'assistant' && message.metadata?.cotPlan && (
                  <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-mono">
                    <span
                      className={
                        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full border ' +
                        (message.metadata.cotPlan === 'upload_deep'
                          ? 'bg-amber-500/10 text-amber-300 border-amber-400/30'
                          : message.metadata.cotPlan === 'repo_plus_upload'
                          ? 'bg-orange-500/10 text-orange-300 border-orange-400/30'
                          : message.metadata.cotPlan === 'multi_repo'
                          ? 'bg-emerald-500/10 text-emerald-300 border-emerald-400/30'
                          : message.metadata.cotPlan === 'single_repo'
                          ? 'bg-sky-500/10 text-sky-300 border-sky-400/30'
                          : message.metadata.cotPlan === 'knowledge_only'
                          ? 'bg-violet-500/10 text-violet-300 border-violet-400/30'
                          : message.metadata.cotPlan === 'voice_first'
                          ? 'bg-fuchsia-500/10 text-fuchsia-300 border-fuchsia-400/30'
                          : 'bg-white/5 text-gray-300 border-white/15')
                      }
                      title={
                        'CoT plan picked by the master router' +
                        (message.metadata.cotPlanSignals
                          ? ` — signals: ${JSON.stringify(message.metadata.cotPlanSignals)}`
                          : '')
                      }
                    >
                      <span className="opacity-60">plan:</span>
                      <span>{message.metadata.cotPlan}</span>
                    </span>
                  </div>
                )}
                {/* Agent Task Stream (Claude Code-style task display) */}
                {message.role === 'assistant' && message.metadata?.agentPlan && (
                  <AgentTaskStream
                    plan={message.metadata.agentPlan}
                    isComplete={!message.metadata?.streaming}
                  />
                )}
                {message.role === 'assistant' ? (
                  message.content ? (
                    <MarkdownRenderer content={message.content} dir={textDir} />
                  ) : message.metadata?.streaming ? (
                    <span className="text-gray-500 text-sm italic">Working...</span>
                  ) : null
                ) : (
                  // Mobile: ensure user messages wrap and don't overflow
                  <p className="text-sm leading-relaxed whitespace-pre-wrap break-words" dir={textDir}>
                    {message.content}
                  </p>
                )}
                {/* Source citation chips intentionally hidden from the
                    default view — operators found them noisy in
                    everyday HR Q&A. The metadata is still attached to
                    each assistant message (message.metadata.citations)
                    so we can wire an opt-in "show sources" toggle
                    later without re-fetching. */}
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

                  {/* Text-to-Speech */}
                  <button
                    onClick={() => handleSpeak(message.id, message.content)}
                    disabled={speechLoading === message.id}
                    className={`p-1.5 rounded-lg hover:bg-white/10 transition-colors ${
                      speakingMessageId === message.id
                        ? 'text-blue-400 bg-blue-400/10'
                        : speechLoading === message.id
                          ? 'text-yellow-400'
                          : 'text-gray-400'
                    }`}
                    title={speakingMessageId === message.id ? 'Stop speaking' : 'Read aloud'}
                  >
                    {speechLoading === message.id ? (
                      <LoaderIcon className="w-3.5 h-3.5 animate-spin" />
                    ) : speakingMessageId === message.id ? (
                      <SquareIcon className="w-3.5 h-3.5" />
                    ) : (
                      <Volume2Icon className="w-3.5 h-3.5" />
                    )}
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
              // Use the operator's chosen avatar (preset SVG or uploaded
              // image) instead of the generic person glyph — same source
              // the SettingsPanel renders, kept in sync via the
              // `simorgh-avatar-changed` event.
              <div className="flex-shrink-0 w-8 h-8 rounded-full overflow-hidden bg-white/10 flex items-center justify-center">
                <img
                  src={userAvatarUrl}
                  alt=""
                  className="w-full h-full object-cover"
                />
              </div>
            )}
          </motion.div>
        );
      })}

      {isTyping && (
        <TypingActivityIndicator messages={messages} />
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