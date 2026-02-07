import React from 'react';

interface SimorghIconProps {
  className?: string;
  size?: number;
}

/**
 * Simorgh AI brand icon - a 4-pointed sparkle star with a small "+" accent.
 * Drop-in replacement for lucide-react icons (accepts className for sizing/color).
 */
export default function SimorghIcon({ className = 'w-8 h-8', size }: SimorghIconProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      width={size}
      height={size}
    >
      {/* Main 4-pointed sparkle star */}
      <path
        d="M30 4 C31 18, 18 29, 4 30 C18 31, 31 42, 30 58 C31 42, 42 31, 56 30 C42 29, 31 18, 30 4Z"
        fill="currentColor"
      />
      {/* Small "+" accent (top-right) */}
      <line x1="49" y1="7" x2="49" y2="17" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
      <line x1="44" y1="12" x2="54" y2="12" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
    </svg>
  );
}
