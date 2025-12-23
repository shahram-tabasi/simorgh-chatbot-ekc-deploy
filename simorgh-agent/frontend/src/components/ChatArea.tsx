import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import WelcomeScreen from './WelcomeScreen';
import GeneralWelcome from './GeneralWelcome';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { Message, UploadedFile } from '../types';

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
  isProjectChat = false
}: ChatAreaProps) {
  const [promptToInsert, setPromptToInsert] = React.useState<string | null>(null);
  // Track chatting state: starts as false (idle), becomes true after first message send
  const [isChatting, setIsChatting] = React.useState(false);

  const isIdle = messages.length === 0 && !isChatting;

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
    <div className="flex-1 flex flex-col h-full relative overflow-hidden">
      {/* Main content area - scrollable only in chatting mode */}
      <div className={`flex-1 flex flex-col ${isIdle ? 'justify-center items-center overflow-y-auto' : 'overflow-y-auto'} px-2 sm:px-4 md:px-8 lg:px-20`}>
        {/* Welcome content - shown in idle mode */}
        {isIdle && (
          <div className="w-full max-w-5xl mx-auto">
            {isProjectChat ? (
              <WelcomeScreen onHide={() => {}} onPromptClick={handlePromptClick} />
            ) : (
              <GeneralWelcome onHide={() => {}} onPromptClick={handlePromptClick} />
            )}
          </div>
        )}

        {/* Message list - shown in chatting mode */}
        {!isIdle && (
          <div className="w-full pt-4 pb-2">
            <MessageList
              messages={messages}
              isTyping={isTyping}
              onRegenerateResponse={onRegenerateResponse}
              onUpdateReaction={onUpdateReaction}
              onSwitchVersion={onSwitchVersion}
              onEditMessage={onEditMessage}
            />
          </div>
        )}
      </div>

      {/* ChatInput - ALWAYS visible, position changes based on state */}
      <div className={`w-full flex-shrink-0 flex justify-center ${
        isIdle
          ? 'pb-8 sm:pb-12 md:pb-16'
          : 'pb-4 sm:pb-6 md:pb-8 border-t border-transparent backdrop-blur-xl'
      }`}>
        <div className={`w-full px-2 sm:px-4 ${isIdle ? 'max-w-3xl' : 'max-w-4xl'}`}>
          <ChatInput
            onSend={handleSend}
            onCancel={onCancelGeneration}
            disabled={disabled || isTyping}
            isGenerating={isTyping}
            editMessage={editingMessage ? { content: editingMessage.content, files: editingMessage.files } : null}
            promptToInsert={promptToInsert}
            centered={isIdle}
          />
        </div>
      </div>
    </div>
  );
}