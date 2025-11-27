import React from 'react';
import { motion } from 'framer-motion';
import { SparklesIcon, SearchIcon, ImageIcon, CodeIcon, LightbulbIcon, TrendingUpIcon, BookOpenIcon } from 'lucide-react';
interface WelcomeScreenProps {
  onHide: () => void;
  onPromptClick: (prompt: string) => void;
}
const suggestedPrompts = [{
  icon: SearchIcon,
  title: 'Deep Research',
  prompt: 'Research the latest developments in quantum computing'
}, {
  icon: CodeIcon,
  title: 'Code Assistant',
  prompt: 'Help me build a React component with TypeScript'
}, {
  icon: ImageIcon,
  title: 'Create Image',
  prompt: 'Generate an image of a futuristic city at sunset'
}, {
  icon: LightbulbIcon,
  title: 'Brainstorm Ideas',
  prompt: 'Give me creative startup ideas for sustainable technology'
}, {
  icon: TrendingUpIcon,
  title: 'Analyze Data',
  prompt: 'Analyze market trends in artificial intelligence'
}, {
  icon: BookOpenIcon,
  title: 'Explain Concept',
  prompt: 'Explain how neural networks work in simple terms'
}];
export function WelcomeScreen({
  onHide,
  onPromptClick
}: WelcomeScreenProps) {
  return <motion.div initial={{
    opacity: 1
  }} exit={{
    opacity: 0,
    scale: 0.95
  }} transition={{
    duration: 0.5
  }} className="flex flex-col items-center justify-center h-full px-4 pb-32">
      {/* Logo */}
      <motion.div initial={{
      scale: 0.8,
      opacity: 0
    }} animate={{
      scale: 1,
      opacity: 1
    }} transition={{
      duration: 0.8,
      ease: 'easeOut'
    }} className="relative mb-8">
        <div className="absolute inset-0 bg-gradient-to-r from-blue-500 to-purple-500 blur-3xl opacity-30" />
        <div className="relative">
          <SparklesIcon className="w-20 h-20 text-white mb-3 mx-auto drop-shadow-2xl" strokeWidth={1.5} />
          <h1 className="text-6xl font-bold text-white tracking-tight text-center grok-logo">
            Simorgh
          </h1>
        </div>
      </motion.div>

      {/* Welcome text */}
      <motion.p initial={{
      opacity: 0,
      y: 20
    }} animate={{
      opacity: 1,
      y: 0
    }} transition={{
      delay: 0.3,
      duration: 0.6
    }} className="text-lg text-gray-400 text-center max-w-md mb-12 font-light">
        What do you want to know?
      </motion.p>

      {/* Suggested prompts */}
      <motion.div initial={{
      opacity: 0,
      y: 20
    }} animate={{
      opacity: 1,
      y: 0
    }} transition={{
      delay: 0.5,
      duration: 0.6
    }} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 max-w-4xl w-full">
        {suggestedPrompts.map((item, i) => {
        const Icon = item.icon;
        return <motion.button key={i} initial={{
          opacity: 0,
          y: 20
        }} animate={{
          opacity: 1,
          y: 0
        }} transition={{
          delay: 0.6 + i * 0.1,
          duration: 0.4
        }} onClick={() => onPromptClick(item.prompt)} className="group p-4 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 transition-all text-left">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-gradient-to-br from-blue-500/20 to-purple-500/20 group-hover:from-blue-500/30 group-hover:to-purple-500/30 transition-all">
                  <Icon className="w-5 h-5 text-blue-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white mb-1">
                    {item.title}
                  </div>
                  <div className="text-xs text-gray-400 line-clamp-2">
                    {item.prompt}
                  </div>
                </div>
              </div>
            </motion.button>;
      })}
      </motion.div>
    </motion.div>;
}