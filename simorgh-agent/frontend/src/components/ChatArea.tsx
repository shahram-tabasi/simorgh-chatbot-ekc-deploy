import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import WelcomeScreen from './WelcomeScreen';
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
  editingMessage = null
}: ChatAreaProps) {
  const [promptToInsert, setPromptToInsert] = React.useState<string | null>(null);
  const showWelcome = messages.length === 0;

  const handlePromptClick = (prompt: string) => {
    if (!disabled) {
      setPromptToInsert(prompt);
      // Reset after a brief moment to allow the effect to trigger
      setTimeout(() => setPromptToInsert(null), 100);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full relative">
      {showWelcome ? (
        <AnimatePresence mode="wait">
          <motion.div
            key="welcome"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3 }}
            className="flex-1 flex flex-col h-full"
          >
            <div className="flex-1 flex items-center justify-center w-full">
              <WelcomeScreen onHide={() => {}} onPromptClick={handlePromptClick} />
            </div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              transition={{ delay: 0.2, duration: 0.4 }}
              className="w-full flex justify-center mb-6 sm:mb-8 md:mb-12 lg:mb-16 pb-safe flex-shrink-0"
            >
              <div className="w-full max-w-3xl px-2 sm:px-4">
                <ChatInput
                  onSend={onSendMessage}
                  onCancel={onCancelGeneration}
                  disabled={disabled || isTyping}
                  isGenerating={isTyping}
                  editMessage={editingMessage ? { content: editingMessage.content, files: editingMessage.files } : null}
                  promptToInsert={promptToInsert}
                  centered
                />
              </div>
            </motion.div>
          </motion.div>
        </AnimatePresence>
      ) : (
        <motion.div
          key="chat"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3 }}
          className="flex-1 flex flex-col h-full overflow-hidden"
        >
          <div className="flex-1 overflow-y-auto px-2 sm:px-4 md:px-8 lg:px-20 pt-4 pb-2">
            <MessageList
              messages={messages}
              isTyping={isTyping}
              onRegenerateResponse={onRegenerateResponse}
              onUpdateReaction={onUpdateReaction}
              onSwitchVersion={onSwitchVersion}
              onEditMessage={onEditMessage}
            />
          </div>

          <div className="w-full flex justify-center pb-4 sm:pb-6 md:pb-8 mb-safe flex-shrink-0">
            <div className="w-full max-w-4xl px-2 sm:px-4">
              <ChatInput
                onSend={onSendMessage}
                onCancel={onCancelGeneration}
                disabled={disabled || isTyping}
                isGenerating={isTyping}
                editMessage={editingMessage ? { content: editingMessage.content, files: editingMessage.files } : null}
                promptToInsert={promptToInsert}
              />
            </div>
          </div>
        </motion.div>
      )}
    </div>
  );
}