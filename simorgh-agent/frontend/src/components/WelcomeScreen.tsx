import React from 'react';
import { Sparkles, Search, Image, Code, Lightbulb, TrendingUp, BookOpen } from 'lucide-react';

interface WelcomeScreenProps {
  onHide: () => void;
  onPromptClick: (prompt: string) => void;
  onPromptDoubleClick?: (prompt: string) => void;
}

const suggestedPrompts = [
  // Single row: all 8 buttons in order
  {
    icon: Image,
    title: 'Site Layout',
    subtitle: 'Site plans and equipment layouts',
    prompt: '',
    enabled: false,
    emoji: '🗺️'
  },
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
    icon: Sparkles,
    title: 'SLD-SLD',
    subtitle: 'Single line diagrams and electrical schematics',
    prompt: '',
    enabled: false,
    emoji: '⚡'
  }
];

export default function WelcomeScreen({ onHide, onPromptClick, onPromptDoubleClick }: WelcomeScreenProps) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-1 md:py-2 w-full">
      {/* Logo - with proper iOS SVG support */}
      <div className="flex flex-col items-center mb-3 md:mb-4">
        <img
          src="/simorgh.svg"
          alt="Simorgh Logo"
          className="w-32 h-32 md:w-40 md:h-40 mb-3 mx-auto drop-shadow-2xl select-none animate-fade-in"
          onError={(e) => {
            // Fallback for iOS if SVG fails to load
            const target = e.target as HTMLImageElement;
            target.style.display = 'none';
          }}
        />
        <img
          src="/text_simorgh.svg"
          alt="Simorgh"
          className="h-20 md:h-24 lg:h-28 drop-shadow-2xl select-none animate-fade-in-delay"
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

      {/* Welcome text */}
      <p className="text-base md:text-lg text-gray-400 text-center max-w-md mb-3 md:mb-4 font-light px-4">
        Ask me anything about electrical engineering, AI,
        <br />or technology
      </p>

      {/* Suggested prompts - Single row slider for Project Welcome */}
      {/* Outer container: width-constrained, isolates overflow, same width as chat input */}
      <div className="w-full max-w-full min-w-0 overflow-x-auto overflow-y-hidden prompt-slider">
        {/* Inner container: inline-flex, no w-full to allow natural overflow */}
        <div className="inline-flex gap-2 px-2 pb-2">
          {suggestedPrompts.map((item, i) => {
            const Icon = item.icon;
            return (
              <button
                key={i}
                onClick={() => item.enabled && onPromptClick(item.prompt)}
                onDoubleClick={() => item.enabled && onPromptDoubleClick?.(item.prompt)}
                disabled={!item.enabled}
                className={`group rounded-2xl border transition-all relative overflow-hidden px-4 py-2.5 flex items-center gap-2.5 flex-shrink-0 ${
                  item.enabled
                    ? 'bg-white/5 hover:bg-white/10 border-white/10 hover:border-white/20 cursor-pointer hover:scale-105 hover:shadow-xl hover:shadow-blue-500/20'
                    : 'bg-white/[0.02] border-white/5 cursor-not-allowed opacity-40'
                }`}
                style={{
                  animation: `fadeInUp 0.4s ease-out ${0.6 + i * 0.1}s backwards`
                }}
              >
                <div className={`text-xl transition-transform ${item.enabled ? 'group-hover:scale-110' : ''}`}>
                  {item.emoji}
                </div>
                <div className="text-xs font-medium text-white lowercase whitespace-nowrap">
                  {item.title}
                </div>
              </button>
            );
          })}
        </div>
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

        /* Hide scrollbar but keep functionality */
        .prompt-slider {
          scrollbar-width: none; /* Firefox */
          -ms-overflow-style: none; /* IE/Edge */
          -webkit-overflow-scrolling: touch; /* iOS momentum scrolling */
        }
        .prompt-slider::-webkit-scrollbar {
          display: none; /* Chrome/Safari/Opera */
        }
      `}</style>
    </div>
  );
}
