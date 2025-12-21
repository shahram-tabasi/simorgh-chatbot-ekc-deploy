import React from 'react';
import { Sparkles, Search, Image, Code, Lightbulb, TrendingUp, BookOpen } from 'lucide-react';

interface WelcomeScreenProps {
  onHide: () => void;
  onPromptClick: (prompt: string) => void;
}

const suggestedPrompts = [
  {
    icon: BookOpen,
    title: 'Specification',
    subtitle: 'Technical specifications and requirements',
    prompt: `Please analyze the attached "General Specification Items.pdf" document and extract all the technical specifications and requirements. 

For each item in the document, provide:
1. The item number and subject name
2. A clear description of what this specification is for
3. The current value or setting (if mentioned)
4. Any important notes about this specification

Organize the information in a clear, structured format with categories like:
- Switchgear Specifications
- Busbar Specifications  
- Wire and Cable Specifications
- Control and Protection Components
- Network and Communication Settings
- Measuring Instruments
- Accessories

Make it easy to understand what each specification means and why it's important for the electrical system.`,
    enabled: true,
    emoji: '📋'
  },
  {
    icon: TrendingUp,
    title: 'Data Sheet',
    subtitle: 'Equipment data sheets and catalogs',
    prompt: '',
    enabled: false,
    emoji: '📊'
  },
  {
    icon: Code,
    title: 'Cable Size',
    subtitle: 'Cable sizing calculations and tables',
    prompt: '',
    enabled: false,
    emoji: '🔌'
  },
  {
    icon: Search,
    title: 'I/O List',
    subtitle: 'Input/Output signal lists and assignments',
    prompt: '',
    enabled: false,
    emoji: '📝'
  },
  {
    icon: Sparkles,
    title: 'Load List',
    subtitle: 'Electrical load calculations and distributions',
    prompt: '',
    enabled: false,
    emoji: '⚡'
  },
  {
    icon: Lightbulb,
    title: 'Logic',
    subtitle: 'Control logic diagrams and sequences',
    prompt: '',
    enabled: false,
    emoji: '🧠'
  },
  {
    icon: Image,
    title: 'Site Layout',
    subtitle: 'Site plans and equipment layouts',
    prompt: '',
    enabled: false,
    emoji: '🗺️'
  },
  {
    icon: Sparkles,
    title: 'SLD-SLD',
    subtitle: 'Single line diagrams and electrical schematics',
    prompt: '',
    enabled: false,
    emoji: '⚡'
  }
];

export default function WelcomeScreen({ onHide, onPromptClick }: WelcomeScreenProps) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-8">
      {/* Logo */}
      <img
        src="/simorgh.svg"
        alt="Simorgh"
        className="w-32 h-32 mb-3 mx-auto drop-shadow-2xl select-none animate-fade-in"
      />
      <img
        src="/text_simorgh.svg"
        alt="Simorgh Text"
        className="h-20 md:h-24 drop-shadow-2xl select-none animate-fade-in-delay"
      />
      
      {/* Welcome text */}
      <p className="text-lg text-gray-400 text-center max-w-md mb-12 font-light mt-4">
        What do you want to know?
      </p>
      
      {/* Suggested prompts */}
      <div className="grid grid-cols-4 gap-3 max-w-3xl w-full">
        {suggestedPrompts.map((item, i) => {
          const Icon = item.icon;
          return (
            <button
              key={i}
              onClick={() => item.enabled && onPromptClick(item.prompt)}
              disabled={!item.enabled}
              className={`group p-3 rounded-xl border transition-all text-center relative overflow-hidden aspect-square flex flex-col items-center justify-center ${
                item.enabled
                  ? 'bg-white/5 hover:bg-white/10 border-white/10 hover:border-white/20 cursor-pointer hover:scale-105 hover:shadow-xl hover:shadow-blue-500/20'
                  : 'bg-white/[0.02] border-white/5 cursor-not-allowed opacity-60'
              }`}
              style={{
                animation: `fadeInUp 0.4s ease-out ${0.6 + i * 0.1}s backwards`
              }}
            >
              <div className="flex flex-col items-center gap-1.5">
                <div className={`text-2xl transition-transform ${item.enabled ? 'group-hover:scale-110' : ''}`}>
                  {item.emoji}
                </div>
                <div className="text-xs font-semibold text-white">
                  {item.title}
                </div>
                <div className="text-[9px] text-gray-400 leading-tight px-1">
                  {item.subtitle}
                </div>
                {!item.enabled && (
                  <div className="mt-0.5 px-1.5 py-0.5 rounded-full bg-red-500/10 border border-red-500/30">
                    <span className="text-[8px] font-medium text-red-400">Coming Soon</span>
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <style>{`
        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        
        .animate-fade-in {
          animation: fadeIn 0.8s ease-out;
        }
        
        .animate-fade-in-delay {
          animation: fadeIn 0.6s ease-out 0.15s backwards;
        }
        
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: scale(0.9);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }
      `}</style>
    </div>
  );
}
