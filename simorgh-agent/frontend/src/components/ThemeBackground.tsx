import React from 'react';
import { useTheme } from '../context/ThemeContext';
import { StarryBackground } from './StarryBackground';
import { PinkEKCBackground } from './backgrounds/PinkEKCBackground';
import { NavySimorghBackground } from './backgrounds/NavySimorghBackground';
import { DarkMatrixBackground } from './backgrounds/DarkMatrixBackground';
import { ModernDarkBackground } from './backgrounds/ModernDarkBackground';
import CleanWhiteBackground from './backgrounds/CleanWhiteBackground';

export function ThemeBackground() {
  const { theme } = useTheme();

  switch (theme) {
    case 'default':
      return <StarryBackground />;
    case 'pink-ekc':
      return <PinkEKCBackground />;
    case 'navy-simorgh':
      return <NavySimorghBackground />;
    case 'dark-matrix':
      return <DarkMatrixBackground />;
    case 'modern-dark':
      return <ModernDarkBackground />;
    case 'clean-white':
      return <CleanWhiteBackground />;
    default:
      return <StarryBackground />;
  }
}
