import React, { useEffect, useState } from 'react';
import { XIcon, DownloadIcon, RotateCcwIcon, HardDriveIcon, UploadIcon } from 'lucide-react';
import {
  BackupInfo, KEEP_PER_PROJECT, listSnapshots, readSnapshot,
} from '../../utils/localBackup';
import { downloadText, fileSafe } from '../../utils/download';

// The copies of this project kept on this computer, and how to get one back.
//
// Everything else about saving is about the database. This is the floor under
// it: if a save went somewhere it should not have, if the network was down, if
// somebody restored the wrong thing — the work is still here, on the machine
// it was done on, and it can be read back.
//
// Snapshots are taken around each save, so the newest ones are minutes apart
// when things are going well and exactly at the moment of trouble when they
// are not — the reason each was taken is in the list.

interface Props {
  projectKey: string;
  projectName: string;
  onClose: () => void;
  onRestore: (project: any) => void;
  onBackupNow: () => Promise<boolean>;
}

const when = (iso: string) => {
  const at = new Date(iso);
  const mins = Math.round((Date.now() - at.getTime()) / 60000);
  const ago = mins < 1 ? 'just now'
    : mins < 60 ? `${mins} min ago`
    : mins < 60 * 24 ? `${Math.round(mins / 60)} h ago`
    : `${Math.round(mins / 1440)} d ago`;
  return `${at.toLocaleString()} · ${ago}`;
};

const size = (bytes: number) =>
  (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`);

export const BackupsModal: React.FC<Props> = ({
  projectKey, projectName, onClose, onRestore, onBackupNow,
}) => {
  const [list, setList] = useState<BackupInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const refresh = () => listSnapshots(projectKey).then(setList);
  useEffect(() => { refresh(); }, [projectKey]);

  const restore = async (info: BackupInfo) => {
    const data = await readSnapshot(info.id);
    if (!data) { setNote('That copy is no longer on this computer.'); return; }
    onRestore(data);
    onClose();
  };

  const download = async (info: BackupInfo) => {
    const data = await readSnapshot(info.id);
    if (!data) { setNote('That copy is no longer on this computer.'); return; }
    const stamp = info.at.slice(0, 19).replace(/[:T]/g, '-');
    downloadText(`${fileSafe(info.projectName || projectName)}-${stamp}.json`,
      JSON.stringify(data, null, 2), 'application/json');
  };

  /** A copy from anywhere — a .json this app wrote, on a USB stick if need be. */
  const fromFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (!data || typeof data !== 'object' || !('projectName' in data)) {
          setNote('That file is not a project exported by this application.');
          return;
        }
        onRestore(data);
        onClose();
      } catch {
        setNote('That file could not be read as a project.');
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[10001] p-4"
      onClick={onClose}>
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-semibold text-gray-800 flex items-center gap-2">
              <HardDriveIcon className="w-4 h-4 text-gray-500" />
              Backups of {projectName || 'this project'}
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Kept on this computer, not on the server — the last {KEEP_PER_PROJECT}, taken
              around each save and always when one fails. Restoring puts a copy back into the
              app; what is on screen now is kept as a backup first.
            </p>
          </div>
          <button className="p-1 hover:bg-gray-100 rounded shrink-0" onClick={onClose}>
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {list === null && <p className="p-6 text-sm text-gray-500">Looking…</p>}
          {list?.length === 0 && (
            <p className="p-6 text-sm text-gray-500">
              No copies yet. One is kept the first time this project is saved — or press
              “Back up now”.
            </p>
          )}
          {list && list.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-gray-400 bg-gray-50 border-b">
                  <th className="text-left font-medium px-4 py-2">When</th>
                  <th className="text-left font-medium px-2 py-2">Why</th>
                  <th className="text-left font-medium px-2 py-2">What is in it</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {list.map(info => (
                  <tr key={info.id}>
                    <td className="px-4 py-2 whitespace-nowrap text-gray-700">{when(info.at)}</td>
                    <td className="px-2 py-2 text-gray-500 whitespace-nowrap">
                      {info.reason}
                      {info.rev != null && <span className="text-gray-400"> · v{info.rev}</span>}
                    </td>
                    <td className="px-2 py-2 text-gray-700">
                      {info.counts.templates} template(s) · {info.counts.equipments} switchgear(s)
                      {' · '}{info.counts.rows} row(s)
                      <span className="text-gray-400"> · {size(info.size)}</span>
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      <button
                        onClick={() => download(info)}
                        title="Save this copy as a .json file"
                        className="px-2 py-1 rounded border border-gray-300 text-xs text-gray-700 hover:bg-gray-50 mr-1.5"
                      >
                        <DownloadIcon className="w-3.5 h-3.5 inline" />
                      </button>
                      <button
                        onClick={() => restore(info)}
                        title="Put this copy back into the app"
                        className="px-2.5 py-1 rounded bg-blue-600 text-white text-xs hover:bg-blue-700"
                      >
                        <RotateCcwIcon className="w-3.5 h-3.5 inline mr-1" />Restore
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {note && <p className="px-4 py-2 text-sm text-amber-700">{note}</p>}
        </div>

        <div className="px-5 py-3 border-t bg-gray-50 flex flex-wrap items-center justify-between gap-2">
          <label className="px-3 py-1.5 text-sm border border-gray-300 rounded bg-white hover:bg-gray-50 cursor-pointer">
            <UploadIcon className="w-3.5 h-3.5 inline mr-1.5" />
            Restore from a .json file…
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) fromFile(f); e.target.value = ''; }}
            />
          </label>
          <div className="flex gap-2">
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const ok = await onBackupNow();
                setNote(ok ? '' : 'This browser would not store a copy — private mode, or no space.');
                await refresh();
                setBusy(false);
              }}
              className="px-4 py-2 text-sm border border-gray-300 rounded bg-white hover:bg-gray-100 disabled:opacity-50"
            >
              {busy ? 'Working…' : 'Back up now'}
            </button>
            <button className="px-4 py-2 text-sm bg-gray-700 text-white rounded hover:bg-gray-800"
              onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BackupsModal;
