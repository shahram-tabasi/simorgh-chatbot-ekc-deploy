// src/components/AvatarPicker.tsx
import React, { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Upload, Check, Trash2 } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

/** Eight built-in avatars rendered fully offline. Each is a tinted
 *  circle with a centered initial — no external requests, no
 *  ui-avatars.com dependency. The colors run a cool→warm palette so
 *  any picker grid reads as a balanced rainbow at a glance. */
const PRESETS = [
  { id: 'sky',     color: '#0ea5e9', glyph: 'S' },
  { id: 'indigo',  color: '#6366f1', glyph: 'I' },
  { id: 'violet',  color: '#8b5cf6', glyph: 'V' },
  { id: 'pink',    color: '#ec4899', glyph: 'P' },
  { id: 'rose',    color: '#f43f5e', glyph: 'R' },
  { id: 'amber',   color: '#f59e0b', glyph: 'A' },
  { id: 'emerald', color: '#10b981', glyph: 'E' },
  { id: 'teal',    color: '#14b8a6', glyph: 'T' },
] as const;

/** Inline-SVG data URL for a preset — used as the `src` of an <img>
 *  so callers can swap it into existing avatar slots without changing
 *  layout. We accept an override glyph so callers can render the
 *  user's actual initial instead of the preset's default letter. */
export function presetAvatarUrl(id: string, glyph?: string): string {
  const preset = PRESETS.find((p) => p.id === id) || PRESETS[0];
  const letter = (glyph || preset.glyph).slice(0, 2).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${preset.color}"/>
        <stop offset="100%" stop-color="${shade(preset.color, -25)}"/>
      </linearGradient>
    </defs>
    <circle cx="40" cy="40" r="38" fill="url(#g)"/>
    <text x="40" y="50" text-anchor="middle" font-family="-apple-system,Inter,Arial,sans-serif"
          font-size="32" font-weight="700" fill="#fff" letter-spacing="-1">${letter}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function shade(hex: string, percent: number): string {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, Math.min(255, (num >> 16) + (percent / 100) * 255));
  const g = Math.max(0, Math.min(255, ((num >> 8) & 0xff) + (percent / 100) * 255));
  const b = Math.max(0, Math.min(255, (num & 0xff) + (percent / 100) * 255));
  return `#${((1 << 24) | (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b))
    .toString(16)
    .slice(1)}`;
}

/** localStorage key for the chosen avatar — either a `preset:<id>`
 *  marker (so we can re-render at the correct size) or a raw data:
 *  URL pasted in from an upload. Scoped per user via the storage key. */
function storageKey(userId?: string | null): string {
  return `simorgh_avatar_${userId || 'anon'}`;
}

export function loadStoredAvatar(userId?: string | null, fallbackGlyph?: string): string | null {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return null;
    if (raw.startsWith('preset:')) {
      return presetAvatarUrl(raw.slice('preset:'.length), fallbackGlyph);
    }
    return raw;
  } catch {
    return null;
  }
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  userId?: string | null;
  /** First letter of display name — used as glyph on preset tiles so
   *  every option already looks personalized. */
  userInitial?: string;
  /** Called with a data: URL (preset SVG or uploaded image) the moment
   *  the operator saves a choice. The parent should re-read storage
   *  via loadStoredAvatar() so any other UserProfile mount updates. */
  onSaved?: (dataUrl: string) => void;
}

export default function AvatarPicker({
  isOpen,
  onClose,
  userId,
  userInitial,
  onSaved,
}: Props) {
  const { t, dir } = useLanguage();
  const fileRef = useRef<HTMLInputElement>(null);
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [uploadedData, setUploadedData] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string>('');

  React.useEffect(() => {
    if (!isOpen) return;
    // Hydrate the selection from whatever is currently saved so the
    // modal opens showing the user's existing choice instead of
    // looking like a fresh pick.
    try {
      const raw = localStorage.getItem(storageKey(userId));
      if (!raw) {
        setSelectedPreset(null);
        setUploadedData(null);
      } else if (raw.startsWith('preset:')) {
        setSelectedPreset(raw.slice('preset:'.length));
        setUploadedData(null);
      } else {
        setUploadedData(raw);
        setSelectedPreset(null);
      }
    } catch {
      setSelectedPreset(null);
      setUploadedData(null);
    }
    setUploadError('');
  }, [isOpen, userId]);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setUploadError('');
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setUploadError('Please pick an image file.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setUploadError('Image must be 2 MB or less.');
      return;
    }
    // Read as data URL so the avatar persists offline in localStorage
    // (no backend round-trip, no remote dependency). Big enough for
    // a 200×200 profile picture; bigger uploads get rejected above.
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || '');
      setUploadedData(url);
      setSelectedPreset(null);
    };
    reader.onerror = () => setUploadError('Could not read that file.');
    reader.readAsDataURL(file);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleSave = () => {
    let value = '';
    if (uploadedData) {
      value = uploadedData;
    } else if (selectedPreset) {
      value = `preset:${selectedPreset}`;
    }
    if (!value) return;
    try {
      localStorage.setItem(storageKey(userId), value);
      const broadcast =
        value.startsWith('preset:')
          ? presetAvatarUrl(value.slice('preset:'.length), userInitial)
          : value;
      onSaved?.(broadcast);
      window.dispatchEvent(new CustomEvent('simorgh-avatar-changed', { detail: broadcast }));
    } catch {}
    onClose();
  };

  const handleClear = () => {
    try { localStorage.removeItem(storageKey(userId)); } catch {}
    setSelectedPreset(null);
    setUploadedData(null);
    onSaved?.('');
    window.dispatchEvent(new CustomEvent('simorgh-avatar-changed', { detail: '' }));
    onClose();
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.96 }}
          transition={{ type: 'spring', damping: 22, stiffness: 280 }}
          onClick={(e) => e.stopPropagation()}
          dir={dir}
          className="w-full max-w-md bg-black/90 border border-white/15 rounded-2xl shadow-2xl overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
            <h3 className="text-white font-semibold text-lg">{t('pickAvatar')}</h3>
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-white/10 rounded-lg transition"
              aria-label={t('close')}
            >
              <X className="w-5 h-5 text-gray-400" />
            </button>
          </div>

          {/* Preset grid */}
          <div className="p-5">
            <div className="grid grid-cols-4 gap-3">
              {PRESETS.map((p) => {
                const active = selectedPreset === p.id && !uploadedData;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setSelectedPreset(p.id);
                      setUploadedData(null);
                    }}
                    className={`relative w-16 h-16 rounded-full mx-auto transition-all ${
                      active
                        ? 'ring-4 ring-emerald-400 scale-105'
                        : 'ring-1 ring-white/15 hover:ring-white/40 hover:scale-105'
                    }`}
                    aria-label={`Avatar ${p.id}`}
                  >
                    <img
                      src={presetAvatarUrl(p.id, userInitial)}
                      alt=""
                      className="w-full h-full rounded-full"
                    />
                    {active && (
                      <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-emerald-400 flex items-center justify-center shadow">
                        <Check className="w-3 h-3 text-black" strokeWidth={3} />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Upload row */}
            <div className="mt-5 pt-5 border-t border-white/10">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className={`w-full flex items-center justify-center gap-2 py-3 rounded-xl border transition ${
                  uploadedData
                    ? 'bg-emerald-500/15 border-emerald-400/50 text-emerald-200'
                    : 'bg-white/5 border-white/15 text-gray-200 hover:bg-white/10'
                }`}
              >
                {uploadedData ? (
                  <>
                    <img
                      src={uploadedData}
                      alt=""
                      className="w-7 h-7 rounded-full object-cover"
                    />
                    <span className="text-sm font-medium">{t('uploadPhoto')}</span>
                    <Check className="w-4 h-4" />
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4" />
                    <span className="text-sm font-medium">{t('uploadPhoto')}</span>
                  </>
                )}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFile}
              />
              {uploadError && (
                <p className="mt-2 text-xs text-red-300">{uploadError}</p>
              )}
            </div>

            {/* Actions */}
            <div className="mt-5 flex items-center gap-2">
              <button
                onClick={handleSave}
                disabled={!selectedPreset && !uploadedData}
                className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 text-white font-medium hover:from-emerald-600 hover:to-teal-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                {t('save')}
              </button>
              <button
                onClick={handleClear}
                className="px-3 py-2.5 rounded-xl bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 transition"
                title={t('delete')}
              >
                <Trash2 className="w-4 h-4" />
              </button>
              <button
                onClick={onClose}
                className="px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 transition"
              >
                {t('cancel')}
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
