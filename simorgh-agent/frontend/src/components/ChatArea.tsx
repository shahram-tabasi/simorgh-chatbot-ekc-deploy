import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { GitBranchIcon, FolderGitIcon, CpuIcon } from 'lucide-react';
import WelcomeScreen from './WelcomeScreen';
import GeneralWelcome from './GeneralWelcome';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { Message, UploadedFile } from '../types';

export interface ChatHeaderContext {
  repoPath?: string | null;
  workingBranch?: string | null;
  baseBranch?: string | null;
  projectName?: string | null;
  model?: string | null;
}

interface ChatAreaProps {
  messages: Message[];
  isTyping: boolean;
  onSendMessage: (content: string, files?: UploadedFile[]) => void;
  onRegenerateResponse?: (messageId: string) => void;
  onUpdateReaction?: (messageId: string, reaction: 'like' | 'dislike' | 'none') => void;
  onSwitchVersion?: (messageId: string, versionIndex: number) => void;
  onEditMessage?: (message: Message) => void;
  onCancelGeneration?: () => void;
  disabled?: boolean;
  editingMessage?: Message | null;
  isProjectChat?: boolean; // NEW: Indicates if this is a project-specific chat
  quotaExceeded?: boolean;
  headerContext?: ChatHeaderContext | null;
}

function ChatHeaderChip({ ctx }: { ctx: ChatHeaderContext }) {
  const repo = ctx.repoPath || ctx.projectName;
  const branch = ctx.workingBranch || ctx.baseBranch;
  const model = ctx.model;
  if (!repo && !branch && !model) return null;
  return (
    <div className="flex-shrink-0 w-full flex justify-center pt-2 px-2 sm:px-4 md:px-8 lg:px-20">
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/[0.04] border border-white/10 text-xs text-gray-300 backdrop-blur-sm max-w-full overflow-hidden">
        {repo && (
          <span className="flex items-center gap-1.5 min-w-0">
            <FolderGitIcon className="w-3.5 h-3.5 text-sky-300/80 flex-shrink-0" />
            <span className="truncate font-mono text-gray-200">{repo}</span>
          </span>
        )}
        {branch && (
          <>
            <span className="text-white/15">·</span>
            <span className="flex items-center gap-1.5 min-w-0">
              <GitBranchIcon className="w-3.5 h-3.5 text-emerald-300/80 flex-shrink-0" />
              <span className="truncate font-mono text-gray-200">{branch}</span>
            </span>
          </>
        )}
        {model && (
          <>
            <span className="text-white/15">·</span>
            <span className="flex items-center gap-1.5 min-w-0">
              <CpuIcon className="w-3.5 h-3.5 text-violet-300/80 flex-shrink-0" />
              <span className="truncate text-gray-200">{model}</span>
            </span>
          </>
        )}
      </div>
    </div>
  );
}

export function ChatArea({
  messages,
  isTyping,
  onSendMessage,
  onRegenerateResponse,
  onUpdateReaction,
  onSwitchVersion,
  onEditMessage,
  onCancelGeneration,
  disabled = false,
  editingMessage = null,
  isProjectChat = false,
  quotaExceeded = false,
  headerContext = null,
}: ChatAreaProps) {
  const [promptToInsert, setPromptToInsert] = React.useState<string | null>(null);
  // Track chatting state: starts as false (idle), becomes true after first message send
  const [isChatting, setIsChatting] = React.useState(false);

  const isIdle = messages.length === 0 && !isChatting;

  // Handle double-click to execute prompt directly
  const handlePromptDoubleClick = (prompt: string) => {
    if (!disabled && prompt) {
      handleSend(prompt);
    }
  };

  // Handle single click to insert prompt
  const handlePromptClick = (prompt: string) => {
    if (!disabled) {
      setPromptToInsert(prompt);
      // Reset after a brief moment to allow the effect to trigger
      setTimeout(() => setPromptToInsert(null), 100);
    }
  };

  // Wrap onSendMessage to detect first send
  const handleSend = React.useCallback((content: string, files?: UploadedFile[]) => {
    // If this is the first message (idle state), transition to chatting
    if (isIdle) {
      setIsChatting(true);
    }
    onSendMessage(content, files);
  }, [isIdle, onSendMessage]);

  // Reset to idle when messages are cleared
  React.useEffect(() => {
    if (messages.length === 0) {
      setIsChatting(false);
    }
  }, [messages.length]);

  return (
    <div className="flex-1 flex flex-col h-full relative overflow-hidden w-full max-w-full min-w-0">
      {/* IDLE MODE: Welcome content with ChatInput integrated - centered vertically */}
      {isIdle && (
        <div className="flex-1 flex flex-col justify-center items-center overflow-y-auto overflow-x-hidden px-2 sm:px-4 md:px-8 lg:px-20 w-full min-w-0">
          <div className="w-full max-w-3xl mx-auto flex flex-col items-center overflow-hidden min-w-0">
            {isProjectChat ? (
              <WelcomeScreen
                onHide={() => {}}
                onPromptClick={handlePromptClick}
                onPromptDoubleClick={handlePromptDoubleClick}
              />
            ) : (
              <GeneralWelcome
                onHide={() => {}}
                onPromptClick={handlePromptClick}
                onPromptDoubleClick={handlePromptDoubleClick}
              />
            )}
            {/* ChatInput - part of welcome content, centered */}
            <div className="w-full px-2 sm:px-4 mt-2">
              <ChatInput
                onSend={handleSend}
                onCancel={onCancelGeneration}
                disabled={disabled || isTyping}
                isGenerating={isTyping}
                editMessage={editingMessage ? { content: editingMessage.content, files: editingMessage.files } : null}
                promptToInsert={promptToInsert}
                centered={true}
                quotaExceeded={quotaExceeded}
                uploadsAllowed={isProjectChat}
              />
            </div>
          </div>
        </div>
      )}

      {/* CHATTING MODE: Messages with fixed bottom ChatInput */}
      {!isIdle && (
        <>
          {/* Repo / branch / model chip — Claude-Code style header strip. */}
          {isProjectChat && headerContext && <ChatHeaderChip ctx={headerContext} />}
          {/* Remove overflow-y-auto from here - let MessageList handle scrolling */}
          <div className="flex-1 flex flex-col pt-2 md:pt-2 overflow-hidden px-2 sm:px-4 md:px-8 lg:px-20">
            <MessageList
              messages={messages}
              isTyping={isTyping}
              onRegenerateResponse={onRegenerateResponse}
              onUpdateReaction={onUpdateReaction}
              onSwitchVersion={onSwitchVersion}
              onEditMessage={onEditMessage}
            />
          </div>

          {/* ChatInput - fixed at bottom in chatting mode */}
          <div
            className="w-full flex-shrink-0 flex justify-center pb-4 sm:pb-6 md:pb-8 border-t border-transparent backdrop-blur-xl"
            style={{ paddingBottom: `max(1rem, calc(1rem + env(safe-area-inset-bottom)))` }}
          >
            <div className="w-full px-2 sm:px-4 max-w-4xl">
              <ChatInput
                onSend={handleSend}
                onCancel={onCancelGeneration}
                disabled={disabled || isTyping}
                isGenerating={isTyping}
                editMessage={editingMessage ? { content: editingMessage.content, files: editingMessage.files } : null}
                promptToInsert={promptToInsert}
                centered={false}
                quotaExceeded={quotaExceeded}
                uploadsAllowed={isProjectChat}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}