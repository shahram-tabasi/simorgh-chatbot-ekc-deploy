import React from 'react';

interface SimorghIconProps {
  className?: string;
  size?: number;
}

/**
 * Simorgh AI brand icon - the phoenix/bird logo from public/favicon.svg.
 * Uses an <img> tag referencing the SVG in the public directory.
 * Drop-in replacement for lucide-react icons (accepts className for sizing).
 */
export default function SimorghIcon({ className = 'w-8 h-8', size }: SimorghIconProps) {
  const baseUrl = import.meta.env.BASE_URL || '/';

  return (
    <img
      src={`${baseUrl}favicon.svg`}
      alt="Simorgh"
      className={className}
      width={size}
      height={size}
      style={{ objectFit: 'contain' }}
    />
  );
}
