import { useState } from 'react';
export function useSidebar(initialState = true) {
  const [isOpen, setIsOpen] = useState(initialState);
  const toggle = () => setIsOpen(prev => !prev);
  const open = () => setIsOpen(true);
  const close = () => setIsOpen(false);
  return {
    isOpen,
    toggle,
    open,
    close
  };
}