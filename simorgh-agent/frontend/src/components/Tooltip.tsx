import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { createPortal } from 'react-dom';

interface TooltipProps {
  content: string;
  children: React.ReactElement;
  delay?: number;
  position?: 'top' | 'bottom' | 'left' | 'right';
}

export function Tooltip({
  content,
  children,
  delay = 500,
  position = 'top'
}: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const timeoutRef = useRef<NodeJS.Timeout>();
  const elementRef = useRef<HTMLDivElement>(null);

  const handleMouseEnter = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();

    // Calculate position based on prop
    let x = rect.left + rect.width / 2;
    let y = rect.top;

    switch (position) {
      case 'top':
        y = rect.top - 8;
        break;
      case 'bottom':
        y = rect.bottom + 8;
        break;
      case 'left':
        x = rect.left - 8;
        y = rect.top + rect.height / 2;
        break;
      case 'right':
        x = rect.right + 8;
        y = rect.top + rect.height / 2;
        break;
    }

    setCoords({ x, y });

    timeoutRef.current = setTimeout(() => {
      setIsVisible(true);
    }, delay);
  };

  const handleMouseLeave = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setIsVisible(false);
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const getPositionStyles = () => {
    switch (position) {
      case 'top':
        return {
          left: coords.x,
          top: coords.y,
          transform: 'translate(-50%, -100%)',
        };
      case 'bottom':
        return {
          left: coords.x,
          top: coords.y,
          transform: 'translate(-50%, 0)',
        };
      case 'left':
        return {
          left: coords.x,
          top: coords.y,
          transform: 'translate(-100%, -50%)',
        };
      case 'right':
        return {
          left: coords.x,
          top: coords.y,
          transform: 'translate(0, -50%)',
        };
    }
  };

  const tooltipContent = (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ duration: 0.15 }}
          className="fixed z-[99999] pointer-events-none"
          style={getPositionStyles()}
        >
          <div className="px-3 py-2 rounded-lg bg-gradient-to-r from-gray-900 to-black border border-white/20 shadow-2xl backdrop-blur-xl">
            <p className="text-sm font-medium text-white whitespace-nowrap max-w-xs">
              {content}
            </p>

            {/* Arrow */}
            <div
              className={`absolute w-2 h-2 bg-gradient-to-r from-gray-900 to-black border-white/20 transform rotate-45 ${
                position === 'top' ? 'bottom-[-4px] left-1/2 -translate-x-1/2 border-b border-r' :
                position === 'bottom' ? 'top-[-4px] left-1/2 -translate-x-1/2 border-t border-l' :
                position === 'left' ? 'right-[-4px] top-1/2 -translate-y-1/2 border-r border-t' :
                'left-[-4px] top-1/2 -translate-y-1/2 border-l border-b'
              }`}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <>
      {React.cloneElement(children, {
        ref: elementRef,
        onMouseEnter: handleMouseEnter,
        onMouseLeave: handleMouseLeave,
      })}

      {createPortal(tooltipContent, document.body)}
    </>
  );
}
