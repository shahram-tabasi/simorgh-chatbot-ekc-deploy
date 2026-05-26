import { useLanguage } from '../context/LanguageContext';

interface GeneralWelcomeProps {
  onHide: () => void;
  onPromptClick: (prompt: string) => void;
  onPromptDoubleClick?: (prompt: string) => void;
}

// Persian HR prompts — single-click sends the full prompt as a message.
const suggestedPrompts = [
  { title: 'انواع مرخصی', prompt: 'انواع مرخصی در شرکت الکتروکویر را توضیح بده.', emoji: '📋' },
  { title: 'انواع مرخصی استحقاقی', prompt: 'انواع مرخصی استحقاقی و شرایط استفاده از آن را توضیح بده.', emoji: '🗓️' },
  { title: 'مجوز خروج', prompt: 'فرآیند درخواست و صدور مجوز خروج در ساعات کاری چگونه است؟', emoji: '🚪' },
  { title: 'مرخصی استعلاجی', prompt: 'شرایط و مدارک لازم برای مرخصی استعلاجی چیست؟', emoji: '🏥' },
  { title: 'مرخصی حج', prompt: 'شرایط و مدت زمان مرخصی حج برای کارکنان چیست؟', emoji: '🕋' },
  { title: 'مرخصی بدون حقوق', prompt: 'شرایط و فرآیند درخواست مرخصی بدون حقوق چگونه است؟', emoji: '📝' },
];

export default function GeneralWelcome({ onPromptClick, onPromptDoubleClick }: GeneralWelcomeProps) {
  const { t, dir } = useLanguage();
  return (
    <div className="flex flex-col items-center justify-center px-2 py-1 md:py-2 w-full max-w-full box-border">
      {/* Logo - tighter on mobile so the prompts fit above the fold. */}
      <div className="flex flex-col items-center justify-center mb-2 md:mb-4 w-full">
        <img
          src={`${import.meta.env.BASE_URL}simorgh.svg`}
          alt="Simorgh Logo"
          className="w-14 h-14 sm:w-20 sm:h-20 md:w-32 md:h-32 mb-1 drop-shadow-2xl select-none animate-fade-in"
          onError={(e) => {
            const target = e.target as HTMLImageElement;
            target.style.display = 'none';
          }}
        />
        <img
          src={`${import.meta.env.BASE_URL}text_simorgh.svg`}
          alt="Simorgh"
          className="h-8 sm:h-12 md:h-20 lg:h-24 drop-shadow-2xl select-none animate-fade-in-delay"
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

      {/* Welcome subtitle — translated via current locale. The
          original copy was Persian-only; with i18n the same surface
          serves EN/FA/DE without re-mounting. */}
      <p
        className="text-sm sm:text-base md:text-lg text-gray-400 text-center max-w-md mb-3 md:mb-5 font-light px-2 w-full"
        dir={dir}
      >
        {t('welcomeTagline')}
      </p>

      {/* Suggested prompts — single horizontal row, swipe/scroll to
          reveal extras (matches the original layout the operator
          wanted preserved). On the desktop the mouse wheel scrolls
          the row sideways; on touch devices it pans. */}
      <div className="w-full max-w-full min-w-0 overflow-x-auto overflow-y-hidden prompt-slider box-border" dir={dir}>
        <div className="inline-flex gap-1.5 sm:gap-2 px-2 pb-2 pr-8">
          {suggestedPrompts.map((item, i) => (
            <button
              key={i}
              // Single click sends the prompt straight to the chat —
              // falls back to insert-only when the parent didn't wire
              // a sender.
              onClick={() => (onPromptDoubleClick ?? onPromptClick)(item.prompt)}
              className="group rounded-xl sm:rounded-2xl border transition-all px-2.5 py-1.5 sm:px-4 sm:py-2.5 flex items-center gap-1.5 sm:gap-2.5 flex-shrink-0
                         bg-white/5 hover:bg-white/10 border-white/10 hover:border-white/20
                         cursor-pointer hover:scale-105 hover:shadow-xl hover:shadow-blue-500/20"
              style={{ animation: `fadeInUp 0.4s ease-out ${0.4 + i * 0.08}s backwards` }}
            >
              <div className="text-base sm:text-xl">{item.emoji}</div>
              <div className="text-[11px] sm:text-xs font-medium text-white whitespace-nowrap">
                {item.title}
              </div>
            </button>
          ))}
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
          overscroll-behavior-x: contain; /* Prevent rubber band effect */
        }
        .prompt-slider::-webkit-scrollbar {
          display: none; /* Chrome/Safari/Opera */
        }
      `}</style>
    </div>
  );
}
