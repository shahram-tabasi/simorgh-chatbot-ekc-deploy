import React, { useEffect, useRef } from 'react';
import { Edit2, Trash2, Plus } from 'lucide-react';

interface ContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
  onCreateNew?: () => void;
  target: 'project' | 'page';
}

export default function ContextMenu({
  x,
  y,
  onClose,
  onRename,
  onDelete,
  onCreateNew,
  target
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  // Adjust position to keep menu on screen
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let adjustedX = x;
      let adjustedY = y;

      if (rect.right > viewportWidth) {
        adjustedX = viewportWidth - rect.width - 10;
      }

      if (rect.bottom > viewportHeight) {
        adjustedY = viewportHeight - rect.height - 10;
      }

      menuRef.current.style.left = `${adjustedX}px`;
      menuRef.current.style.top = `${adjustedY}px`;
    }
  }, [x, y]);

  return (
    <div
      ref={menuRef}
      style={{ left: x, top: y }}
      className="fixed z-[9999] bg-gradient-to-br from-gray-900 to-black border border-white/20 rounded-lg shadow-2xl py-2 min-w-[200px] backdrop-blur-xl"
    >
      <button
        onClick={() => {
          onRename();
          onClose();
        }}
        className="w-full px-4 py-2 text-left text-white hover:bg-white/10 flex items-center gap-3 transition group"
      >
        <Edit2 className="w-4 h-4 text-blue-400 group-hover:text-blue-300" />
        <span>Rename {target === 'project' ? 'Project' : 'Page'}</span>
      </button>

      <button
        onClick={() => {
          onDelete();
          onClose();
        }}
        className="w-full px-4 py-2 text-left text-red-400 hover:bg-red-500/10 flex items-center gap-3 transition group"
      >
        <Trash2 className="w-4 h-4 group-hover:text-red-300" />
        <span>Delete {target === 'project' ? 'Project' : 'Page'}</span>
      </button>

      {onCreateNew && (
        <>
          <div className="border-t border-white/10 my-2" />

          <button
            onClick={() => {
              onCreateNew();
              onClose();
            }}
            className="w-full px-4 py-2 text-left text-emerald-400 hover:bg-emerald-500/10 flex items-center gap-3 transition group"
          >
            <Plus className="w-4 h-4 group-hover:text-emerald-300" />
            <span>Create New {target === 'project' ? 'Project' : 'Page'}</span>
          </button>
        </>
      )}
    </div>
  );
}
