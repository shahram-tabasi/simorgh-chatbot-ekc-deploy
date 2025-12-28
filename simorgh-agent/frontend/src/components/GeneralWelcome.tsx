import React from 'react';
import { Brain, Zap, CircuitBoard, Cpu, Lightbulb, Shield, Settings, TrendingUp } from 'lucide-react';

interface GeneralWelcomeProps {
  onHide: () => void;
  onPromptClick: (prompt: string) => void;
  onPromptDoubleClick?: (prompt: string) => void;
}

const suggestedPrompts = [
  // Row 1: 5 buttons
  {
    icon: Lightbulb,
    title: 'Short Circuit Analysis',
    subtitle: 'Fault current calculations',
    prompt: `Explain the methodology for calculating short circuit currents in electrical networks. What are the key factors that affect fault levels, and how do you ensure equipment ratings are adequate?`,
    enabled: true,
    emoji: '💡'
  },
  {
    icon: Brain,
    title: 'AI in Electrical Design',
    subtitle: 'AI applications in engineering',
    prompt: `Explain how artificial intelligence and machine learning can be applied to electrical panel design and optimization. What are the key benefits and current limitations?`,
    enabled: true,
    emoji: '🤖'
  },
  {
    icon: Zap,
    title: 'Transformer Ratings',
    subtitle: 'Understanding transformer specifications',
    prompt: `Explain the key parameters for transformer selection including rated voltage, power rating (kVA), impedance, and insulation class. What are the standard ratings for industrial applications?`,
    enabled: true,
    emoji: '⚡'
  },
  {
    icon: CircuitBoard,
    title: 'LV Switchgear Best Practices',
    subtitle: 'Low voltage panel design',
    prompt: `What are the best practices for designing low voltage (LV) switchgear panels? Include considerations for busbar sizing, circuit breaker selection, IP rating, and thermal management.`,
    enabled: true,
    emoji: '📟'
  },
  {
    icon: TrendingUp,
    title: 'Energy Efficiency',
    subtitle: 'Power quality and optimization',
    prompt: `What are the best practices for improving energy efficiency in industrial electrical systems? Discuss power factor correction, harmonic mitigation, and load optimization strategies.`,
    enabled: true,
    emoji: '📊'
  },
  // Row 2: 3 buttons
  {
    icon: Shield,
    title: 'Protection Coordination',
    subtitle: 'Protective device coordination',
    prompt: `Explain the principles of protection coordination in electrical distribution systems. How do you ensure proper coordination between upstream and downstream protective devices?`,
    enabled: true,
    emoji: '🛡️'
  },
  {
    icon: Settings,
    title: 'IEC vs ANSI Standards',
    subtitle: 'International electrical standards',
    prompt: `Compare IEC (International Electrotechnical Commission) and ANSI (American National Standards Institute) standards for electrical equipment. What are the key differences in voltage levels, protection schemes, and equipment ratings?`,
    enabled: true,
    emoji: '📐'
  },
  {
    icon: Cpu,
    title: 'Smart Grid Technology',
    subtitle: 'Modern distribution systems',
    prompt: `Describe the key components and benefits of smart grid technology in electrical distribution systems. How do IoT sensors, automation, and AI enhance grid reliability and efficiency?`,
    enabled: true,
    emoji: '🌐'
  }
];

export default function GeneralWelcome({ onHide, onPromptClick, onPromptDoubleClick }: GeneralWelcomeProps) {
  return (
    <div className="flex flex-col items-center justify-center px-2 py-1 md:py-2 w-full max-w-full">
      {/* Logo - smaller on mobile */}
      <div className="flex flex-col items-center mb-2 md:mb-4">
        <img
          src="/simorgh.svg"
          alt="Simorgh Logo"
          className="w-20 h-20 sm:w-28 sm:h-28 md:w-40 md:h-40 mb-2 mx-auto drop-shadow-2xl select-none animate-fade-in"
          onError={(e) => {
            const target = e.target as HTMLImageElement;
            target.style.display = 'none';
          }}
        />
        <img
          src="/text_simorgh.svg"
          alt="Simorgh"
          className="h-12 sm:h-16 md:h-24 lg:h-28 drop-shadow-2xl select-none animate-fade-in-delay"
          onError={(e) => {
            const target = e.target as HTMLImageElement;
            target.style.display = 'none';
            const fallback = document.createElement('h1');
            fallback.className = 'text-2xl sm:text-3xl md:text-5xl font-bold text-white grok-logo';
            fallback.textContent = 'SIMORGH';
            target.parentNode?.appendChild(fallback);
          }}
        />
      </div>

      {/* Welcome text - smaller on mobile */}
      <p className="text-sm sm:text-base md:text-lg text-gray-400 text-center max-w-md mb-2 md:mb-4 font-light px-2">
        Ask me anything about electrical engineering, AI,
        <br />or technology
      </p>

      {/* Suggested prompts - Single row slider */}
      <div className="w-full max-w-full min-w-0 overflow-x-auto overflow-y-hidden prompt-slider">
        <div className="inline-flex gap-1.5 sm:gap-2 px-2 pb-2">
          {suggestedPrompts.map((item, i) => {
            const Icon = item.icon;
            return (
              <button
                key={i}
                onClick={() => item.enabled && onPromptClick(item.prompt)}
                onDoubleClick={() => item.enabled && onPromptDoubleClick?.(item.prompt)}
                disabled={!item.enabled}
                className={`group rounded-xl sm:rounded-2xl border transition-all relative overflow-hidden px-2.5 py-1.5 sm:px-4 sm:py-2.5 flex items-center gap-1.5 sm:gap-2.5 flex-shrink-0 ${
                  item.enabled
                    ? 'bg-white/5 hover:bg-white/10 border-white/10 hover:border-white/20 cursor-pointer hover:scale-105 hover:shadow-xl hover:shadow-blue-500/20'
                    : 'bg-white/[0.02] border-white/5 cursor-not-allowed opacity-40'
                }`}
                style={{
                  animation: `fadeInUp 0.4s ease-out ${0.6 + i * 0.1}s backwards`
                }}
              >
                <div className={`text-base sm:text-xl transition-transform ${item.enabled ? 'group-hover:scale-110' : ''}`}>
                  {item.emoji}
                </div>
                <div className="text-[10px] sm:text-xs font-medium text-white lowercase whitespace-nowrap">
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
