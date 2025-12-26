import React from 'react';
import { Brain, Zap, CircuitBoard, Cpu, Lightbulb, Shield, Settings, TrendingUp } from 'lucide-react';

interface GeneralWelcomeProps {
  onHide: () => void;
  onPromptClick: (prompt: string) => void;
}

const suggestedPrompts = [
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
  },
  {
    icon: Lightbulb,
    title: 'Short Circuit Analysis',
    subtitle: 'Fault current calculations',
    prompt: `Explain the methodology for calculating short circuit currents in electrical networks. What are the key factors that affect fault levels, and how do you ensure equipment ratings are adequate?`,
    enabled: true,
    emoji: '💡'
  },
  {
    icon: TrendingUp,
    title: 'Energy Efficiency',
    subtitle: 'Power quality and optimization',
    prompt: `What are the best practices for improving energy efficiency in industrial electrical systems? Discuss power factor correction, harmonic mitigation, and load optimization strategies.`,
    enabled: true,
    emoji: '📊'
  }
];

export default function GeneralWelcome({ onHide, onPromptClick }: GeneralWelcomeProps) {
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
        Ask me anything about electrical engineering, AI, or technology
      </p>

      {/* Suggested prompts */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 sm:gap-3 max-w-3xl w-full">
        {suggestedPrompts.map((item, i) => {
          const Icon = item.icon;
          return (
            <button
              key={i}
              onClick={() => item.enabled && onPromptClick(item.prompt)}
              disabled={!item.enabled}
              className={`group p-1.5 sm:p-3 rounded-xl border transition-all text-center relative overflow-hidden aspect-square flex flex-col items-center justify-center ${
                item.enabled
                  ? 'bg-white/5 hover:bg-white/10 border-white/10 hover:border-white/20 cursor-pointer hover:scale-105 hover:shadow-xl hover:shadow-blue-500/20'
                  : 'bg-white/[0.02] border-white/5 cursor-not-allowed opacity-60'
              }`}
              style={{
                animation: `fadeInUp 0.4s ease-out ${0.6 + i * 0.1}s backwards`
              }}
            >
              <div className="flex flex-col items-center gap-0.5 sm:gap-1.5">
                <div className={`text-xl sm:text-2xl transition-transform ${item.enabled ? 'group-hover:scale-110' : ''}`}>
                  {item.emoji}
                </div>
                <div className="text-[10px] sm:text-xs font-semibold text-white">
                  {item.title}
                </div>
                <div className="text-[8px] sm:text-[9px] text-gray-400 leading-tight px-1">
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
