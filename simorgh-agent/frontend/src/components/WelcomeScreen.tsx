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
<motion.img
  src="/simorgh-sky.svg"
  alt="Simorgh Sky"
  initial={{ opacity: 0, scale: 0.9 }}
  animate={{ opacity: 1, scale: 1 }}
  transition={{ duration: 0.8, ease: 'easeOut' }}
  className="w-20 h-20 mb-3 mx-auto drop-shadow-2xl select-none"
/>

    <motion.img
      src="/text_simorgh.svg"
      alt="Simorgh"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.15, duration: 0.6 }}
      className="h-16 md:h-20 drop-shadow-2xl select-none"
    />
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
