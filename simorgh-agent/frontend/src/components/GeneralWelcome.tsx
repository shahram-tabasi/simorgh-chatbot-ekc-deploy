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

      {/* Welcome text - Persian, smaller on mobile */}
      <p
        className="text-sm sm:text-base md:text-lg text-gray-400 text-center max-w-md mb-3 md:mb-5 font-light px-2 w-full"
        dir="rtl"
      >
        برای شروع روی یکی از موضوعات زیر کلیک کنید
      </p>

      {/* Suggested prompts — wrap into rows, single click sends. */}
      <div className="w-full max-w-2xl mx-auto px-2" dir="rtl">
        <div className="flex flex-wrap justify-center gap-2 sm:gap-2.5 pb-2">
          {suggestedPrompts.map((item, i) => (
            <button
              key={i}
              // Single click sends the prompt straight to the chat — falls
              // back to insert-only when the parent didn't wire a sender.
              onClick={() => (onPromptDoubleClick ?? onPromptClick)(item.prompt)}
              className="group rounded-full border transition-all px-3 py-1.5 sm:px-4 sm:py-2 flex items-center gap-2 flex-shrink-0
                         bg-white/5 hover:bg-white/10 border-white/10 hover:border-blue-400/40
                         cursor-pointer hover:shadow-lg hover:shadow-blue-500/10"
              style={{ animation: `fadeInUp 0.4s ease-out ${0.4 + i * 0.08}s backwards` }}
            >
              <span className="text-base sm:text-lg">{item.emoji}</span>
              <span className="text-xs sm:text-sm font-medium text-white whitespace-nowrap">
                {item.title}
              </span>
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
