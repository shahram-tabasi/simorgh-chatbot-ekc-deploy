import { useState, useEffect, useCallback } from 'react';

export function useSidebar(initialState = true) {
  // Check if mobile on initial render
  const isMobileInitial = typeof window !== 'undefined' && window.innerWidth < 768;

  // Start closed on mobile, use initialState on desktop
  const [isOpen, setIsOpen] = useState(isMobileInitial ? false : initialState);

  // Handle browser back button on mobile
  useEffect(() => {
    const handlePopState = () => {
      if (window.innerWidth < 768 && isOpen) {
        setIsOpen(false);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [isOpen]);

  const toggle = useCallback(() => {
    setIsOpen(prev => {
      const newState = !prev;
      // Push history state when opening sidebar on mobile
      if (newState && window.innerWidth < 768) {
        window.history.pushState({ sidebarOpen: true }, '');
      }
      return newState;
    });
  }, []);

  const open = useCallback(() => {
    // Push history state when opening sidebar on mobile
    if (window.innerWidth < 768) {
      window.history.pushState({ sidebarOpen: true }, '');
    }
    setIsOpen(true);
  }, []);

  const close = useCallback(() => setIsOpen(false), []);

  return {
    isOpen,
    toggle,
    open,
    close
  };
}
