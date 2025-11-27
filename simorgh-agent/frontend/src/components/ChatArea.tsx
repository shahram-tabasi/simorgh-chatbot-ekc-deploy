import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { WelcomeScreen } from './WelcomeScreen';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { Message, UploadedFile } from '../types';

interface ChatAreaProps {
  messages: Message[];
  isTyping: boolean;
  onSendMessage: (content: string, files?: UploadedFile[]) => void;
  disabled?: boolean;
}

export function ChatArea({
  messages,
  isTyping,
  onSendMessage,
  disabled = false
}: ChatAreaProps) {
  const showWelcome = messages.length === 0;

  const handlePromptClick = (prompt: string) => {
    if (!disabled) {
      onSendMessage(prompt);
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
              className="w-full flex justify-center mb-24"
            >
              <div className="w-full max-w-3xl px-4">
                <ChatInput
                  onSend={onSendMessage}
                  disabled={disabled || isTyping}
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
          className="flex-1 flex flex-col h-full"
        >
          <div className="flex-1 overflow-hidden pl-20 pr-20 pt-4">
            <MessageList messages={messages} isTyping={isTyping} />
          </div>

          <div className="w-full flex justify-center pb-6">
            <div className="w-full max-w-4xl px-4">
              <ChatInput
                onSend={onSendMessage}
                disabled={disabled || isTyping}
              />
            </div>
          </div>
        </motion.div>
      )}
    </div>
  );
}