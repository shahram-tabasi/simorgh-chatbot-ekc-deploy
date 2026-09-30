import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';

// Panels that can be put away, and a menu that brings them back.
//
// EPLAN works this way and so does every CAD package: a navigator is closed
// when it is in the way and reopened from View when it is wanted, and the
// drawing takes the room in between. Nothing is ever lost by closing a panel —
// it is a view, not a document — which is what makes it safe to close.
//
// The rule that makes it safe here: a panel that is closed must always be
// findable. A panel registers itself the first time it renders, and stays in
// the registry for the rest of the session even while it is hidden, so View →
// Panels always lists it. Otherwise closing the last panel of a kind would
// hide the very control that reopens it.
//
// What is open is kept per person in the browser, not in the project: two
// engineers on the same project have different screens and different habits.

export interface PanelInfo {
  id: string;
  /** What the menu calls it. */
  label: string;
  /** Under which menu heading it is grouped. */
  group?: string;
  /** The screen it belongs to, so the menu can say where it lives. */
  note?: string;
}

interface PanelsValue {
  /** Every panel that has made itself known this session, in registration order. */
  panels: PanelInfo[];
  isOpen: (id: string) => boolean;
  setOpen: (id: string, open: boolean) => void;
  toggle: (id: string) => void;
  /** Put every registered panel back on screen. */
  showAll: () => void;
  register: (info: PanelInfo) => void;
}

const PanelsContext = createContext<PanelsValue | null>(null);

const KEY = 'simorgh-panels';

/** What was closed last time. Only closures are stored; anything unheard of is open. */
function loadClosed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string') : []);
  } catch {
    // A browser that will not keep anything is not an error; everything opens.
    return new Set();
  }
}

export const PanelsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [closed, setClosed] = useState<Set<string>>(loadClosed);
  const [panels, setPanels] = useState<PanelInfo[]>([]);
  // Registration happens during render of the panels themselves, so it is
  // funnelled through a ref and flushed once — a setState from inside another
  // component's render is not allowed, and a panel that re-renders often
  // should not re-register on every pass.
  const known = useRef(new Map<string, PanelInfo>());

  useEffect(() => {
    try { window.localStorage.setItem(KEY, JSON.stringify([...closed])); }
    catch { /* nothing to do */ }
  }, [closed]);

  const register = useCallback((info: PanelInfo) => {
    const had = known.current.get(info.id);
    if (had && had.label === info.label && had.group === info.group && had.note === info.note) return;
    known.current.set(info.id, info);
    setPanels([...known.current.values()]);
  }, []);

  const setOpen = useCallback((id: string, open: boolean) => {
    setClosed(prev => {
      const next = new Set(prev);
      if (open) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const value = useMemo<PanelsValue>(() => ({
    panels,
    isOpen: (id: string) => !closed.has(id),
    setOpen,
    toggle: (id: string) => setOpen(id, closed.has(id)),
    showAll: () => setClosed(new Set()),
    register,
  }), [panels, closed, setOpen, register]);

  return <PanelsContext.Provider value={value}>{children}</PanelsContext.Provider>;
};

/**
 * The registry, for the menu that lists the panels.
 *
 * Returns null outside a provider rather than throwing, so a screen mounted on
 * its own — a test harness, a preview — still renders instead of blowing up.
 */
export const usePanelRegistry = (): PanelsValue | null => useContext(PanelsContext);

/**
 * One panel's own handle on whether it is showing.
 *
 * Registering here is what puts it in the View menu, so a panel gets its menu
 * entry by asking this question rather than by anybody maintaining a list.
 * Without a provider it is simply always open, which is what it was before any
 * of this existed.
 */
export function usePanel(info: PanelInfo): {
  open: boolean; show: () => void; hide: () => void; toggle: () => void;
} {
  const ctx = useContext(PanelsContext);
  const { id, label, group, note } = info;

  useEffect(() => {
    ctx?.register({ id, label, group, note });
  }, [ctx, id, label, group, note]);

  const open = ctx ? ctx.isOpen(id) : true;
  return {
    open,
    show: useCallback(() => ctx?.setOpen(id, true), [ctx, id]),
    hide: useCallback(() => ctx?.setOpen(id, false), [ctx, id]),
    toggle: useCallback(() => ctx?.toggle(id), [ctx, id]),
  };
}
