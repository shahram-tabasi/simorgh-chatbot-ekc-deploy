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
    subtitle: 'Extract technical specifications using AI agent',
    prompt: `__AGENT__:SPECIFICATION_EXTRACTION`,
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
    <div className="flex flex-col items-center justify-center px-4 py-2 md:py-8 w-full min-h-[calc(100vh-14rem)] md:min-h-0">
      {/* Logo - with proper iOS SVG support */}
      <div className="flex flex-col items-center mb-4 md:mb-8">
        <img
          src="/simorgh.svg"
          alt="Simorgh Logo"
          className="w-24 h-24 md:w-32 md:h-32 mb-3 mx-auto drop-shadow-2xl select-none animate-fade-in"
          onError={(e) => {
            // Fallback for iOS if SVG fails to load
            const target = e.target as HTMLImageElement;
            target.style.display = 'none';
          }}
        />
        <img
          src="/text_simorgh.svg"
          alt="Simorgh"
          className="h-16 md:h-20 lg:h-24 drop-shadow-2xl select-none animate-fade-in-delay"
          onError={(e) => {
            // Fallback text for iOS
            const target = e.target as HTMLImageElement;
            target.style.display = 'none';
            const fallback = document.createElement('h1');
            fallback.className = 'text-4xl md:text-5xl font-bold text-white grok-logo';
            fallback.textContent = 'SIMORGH';
            target.parentNode?.appendChild(fallback);
          }}
        />
      </div>

      {/* Welcome text - centered on mobile */}
      <p className="text-base md:text-lg text-gray-400 text-center max-w-md mb-6 md:mb-12 font-light px-4">
        What do you want to know?
      </p>

      {/* Suggested prompts */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5 sm:gap-2 max-w-3xl w-full">
        {suggestedPrompts.map((item, i) => {
          const Icon = item.icon;
          return (
            <button
              key={i}
              onClick={() => item.enabled && onPromptClick(item.prompt)}
              disabled={!item.enabled}
              className={`group p-1 sm:p-2 rounded-xl border transition-all text-center relative overflow-hidden w-28 h-28 sm:w-32 sm:h-32 flex flex-col items-center justify-center ${
                item.enabled
                  ? 'bg-white/5 hover:bg-white/10 border-white/10 hover:border-white/20 cursor-pointer hover:scale-105 hover:shadow-xl hover:shadow-blue-500/20'
                  : 'bg-white/[0.02] border-white/5 cursor-not-allowed opacity-60'
              }`}
              style={{
                animation: `fadeInUp 0.4s ease-out ${0.6 + i * 0.1}s backwards`
              }}
            >
              <div className="flex flex-col items-center gap-0.5 sm:gap-1">
                <div className={`text-base sm:text-lg transition-transform ${item.enabled ? 'group-hover:scale-110' : ''}`}>
                  {item.emoji}
                </div>
                <div className="text-[9px] sm:text-[10px] font-semibold text-white">
                  {item.title}
                </div>
                <div className="text-[7px] sm:text-[8px] text-gray-400 leading-tight px-1">
                  {item.subtitle}
                </div>
                {!item.enabled && (
                  <div className="mt-0.5 px-1 sm:px-1.5 py-0.5 rounded-full bg-red-500/10 border border-red-500/30">
                    <span className="text-[7px] sm:text-[8px] font-medium text-red-400">Coming Soon</span>
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
