import React, { useRef, useState } from 'react';
import { ImageIcon, Trash2Icon, XIcon } from 'lucide-react';
import { Signer, TitleBlockSettings } from '../../types/project';

// The set's sign-off: whose drawing it is, and who drew, checked and approved
// it — with a logo and the signatures as pictures.
//
// Set once for the project and put into every title block the editor draws
// and every report page, so a PDF leaves the office signed the same way on
// every sheet instead of with the DRAWN box typed into some of them.

interface Props {
  value: TitleBlockSettings;
  canEdit: boolean;
  onSave: (next: TitleBlockSettings) => void;
  onClose: () => void;
}

/**
 * A picture as a data URL small enough to keep in the project.
 *
 * A phone photo of a signature is several megabytes and would travel with
 * every save; drawn at the size a title block prints it, 600 pixels across is
 * more than enough. PNG, so a signature cut out on a transparent background
 * stays that way on the paper.
 */
async function pictureOf(file: File, maxW = 600, maxH = 300): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => fail(new Error('unreadable'));
      i.src = url;
    });
    const k = Math.min(1, maxW / img.width, maxH / img.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * k));
    canvas.height = Math.max(1, Math.round(img.height * k));
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

const ROLES: { key: 'drawn' | 'checked' | 'approved'; label: string; note: string }[] = [
  { key: 'drawn', label: 'Drawn', note: 'DRAWN' },
  { key: 'checked', label: 'Checked', note: 'CHECKED' },
  { key: 'approved', label: 'Approved', note: 'APPROVED — its cell appears only when somebody is named or signed here' },
];

export const TitleBlockDialog: React.FC<Props> = ({ value, canEdit, onSave, onClose }) => {
  const [draft, setDraft] = useState<TitleBlockSettings>(value);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const target = useRef<'logo' | 'drawn' | 'checked' | 'approved'>('logo');

  const pick = (which: typeof target.current) => {
    target.current = which;
    file.current?.click();
  };

  const read = async (f: File | undefined) => {
    if (!f) return;
    try {
      const pic = await pictureOf(f, target.current === 'logo' ? 500 : 600, target.current === 'logo' ? 250 : 300);
      setError(null);
      if (target.current === 'logo') setDraft(d => ({ ...d, logo: pic }));
      else {
        const role = target.current;
        setDraft(d => ({ ...d, [role]: { ...(d[role] ?? {}), sign: pic } }));
      }
    } catch {
      setError(`${f.name} could not be read as a picture.`);
    } finally {
      if (file.current) file.current.value = '';
    }
  };

  const setSigner = (role: 'drawn' | 'checked' | 'approved', patch: Partial<Signer>) =>
    setDraft(d => ({ ...d, [role]: { ...(d[role] ?? {}), ...patch } }));

  const Picture: React.FC<{ src?: string; onPick: () => void; onClear: () => void; label: string }> =
    ({ src, onPick, onClear, label }) => (
      <div className="flex items-center gap-2">
        <div className="w-40 h-14 border border-dashed border-gray-300 rounded bg-white flex items-center justify-center overflow-hidden">
          {src ? <img src={src} alt={label} className="max-w-full max-h-full object-contain" />
            : <span className="text-[11px] text-gray-400">no picture</span>}
        </div>
        <button
          onClick={onPick} disabled={!canEdit}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-gray-300 hover:bg-gray-100 disabled:opacity-40"
        >
          <ImageIcon className="w-3.5 h-3.5" /> {src ? 'Replace' : 'Upload'}
        </button>
        {src && (
          <button
            onClick={onClear} disabled={!canEdit} title="Remove the picture"
            className="p-1 rounded text-gray-400 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-40"
          >
            <Trash2Icon className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    );

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[220] p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-2xl w-[640px] max-w-full max-h-[92vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="bg-slate-700 text-white px-5 py-3 flex items-center justify-between rounded-t-lg">
          <div>
            <h2 className="text-base font-semibold">Title block &amp; signatures</h2>
            <p className="text-[11px] text-slate-200">Set once for the project — every page's title block and every report page carries it.</p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/20"><XIcon className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5 text-sm">
          <section className="space-y-2">
            <label className="block">
              <span className="text-xs text-gray-600">Company (OWNER cell)</span>
              <input
                value={draft.company ?? ''} disabled={!canEdit}
                onChange={e => setDraft(d => ({ ...d, company: e.target.value }))}
                className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5"
                placeholder="Your company's name"
              />
            </label>
            <div>
              <span className="text-xs text-gray-600">Logo</span>
              <Picture src={draft.logo} label="logo" onPick={() => pick('logo')}
                onClear={() => setDraft(d => ({ ...d, logo: undefined }))} />
            </div>
          </section>

          {ROLES.map(role => (
            <section key={role.key} className="border-t pt-4 space-y-2">
              <div className="flex items-baseline gap-2">
                <h3 className="font-semibold text-gray-800">{role.label}</h3>
                <span className="text-[11px] text-gray-400">{role.note}</span>
              </div>
              <input
                value={draft[role.key]?.name ?? ''} disabled={!canEdit}
                onChange={e => setSigner(role.key, { name: e.target.value })}
                className="w-full border border-gray-300 rounded px-2 py-1.5"
                placeholder="Name"
              />
              <Picture src={draft[role.key]?.sign} label={`${role.label} signature`}
                onPick={() => pick(role.key)} onClear={() => setSigner(role.key, { sign: undefined })} />
            </section>
          ))}

          {error && <p className="text-xs text-rose-700 bg-rose-50 rounded px-2 py-1">{error}</p>}
          <p className="text-[11px] text-gray-500">
            A page that already has its frame is refreshed by turning it off and on (Output → Header);
            report pages are drawn with it every time. Pictures go into the screen, the SVG and the PDF; a DXF has nowhere to keep one.
          </p>
        </div>

        <div className="px-5 py-3 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-100">Cancel</button>
          <button
            onClick={() => { onSave(draft); onClose(); }} disabled={!canEdit}
            className="px-4 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
          >
            Save
          </button>
        </div>

        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
          onChange={e => read(e.target.files?.[0])} />
      </div>
    </div>
  );
};
