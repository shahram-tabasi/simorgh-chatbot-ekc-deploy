import React, { useEffect, useState } from 'react';
import { XIcon, DownloadIcon, RotateCcwIcon, HistoryIcon, AlertTriangleIcon } from 'lucide-react';
import { ProjectData } from '../../types/project';
import { ProjectVersion, VersionSwitchgear, projectService } from '../../services/projectService';
import { downloadText, fileSafe } from '../../utils/download';
import { appConfirm } from './AppDialog';

// Every version of this project the server kept, and the two ways back.
//
// The server keeps the document it is about to replace, on every save, spaced
// a couple of minutes apart and sixty deep — a little over two hours of real
// work. This is where somebody reads them and picks one, without asking
// anybody for help and without a database client.
//
// Two ways back, because they are different jobs:
//
//   **One switchgear.** The usual one. A morning's rows on one panel went and
//   nothing should happen to the other nine.
//
//   **The whole project.** For when what went is the shape of the project
//   itself — templates, the device library, several switchgears at once.
//
// Either way, what is on screen now is written to a file first, so choosing
// the wrong version is not the thing that loses the afternoon.

interface Props {
  projectId: string;
  projectName: string;
  onClose: () => void;
  onRestoreProject: (project: ProjectData) => void;
  onRestoreSwitchgear: (project: ProjectData, equipmentId: string) => void;
}

const ago = (iso: string) => {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
};

export const ProjectHistoryModal: React.FC<Props> = ({
  projectId, projectName, onClose, onRestoreProject, onRestoreSwitchgear,
}) => {
  const [versions, setVersions] = useState<ProjectVersion[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    projectService.listProjectHistory(projectId)
      .then(rows => { if (!cancelled) setVersions(rows); })
      .catch(e => { if (!cancelled) { setError(e?.message || 'Could not read the history'); setVersions([]); } });
    return () => { cancelled = true; };
  }, [projectId]);

  /** Fetch a version and hand it to whoever asked for it. */
  const withVersion = async (v: ProjectVersion, use: (project: ProjectData) => void) => {
    setBusy(true);
    try {
      use(await projectService.readProjectVersion(projectId, v._id));
    } catch (e) {
      setError((e as Error)?.message || 'Could not read that version');
    } finally {
      setBusy(false);
    }
  };

  const restoreWhole = async (v: ProjectVersion) => {
    if (!await appConfirm(
      `Put the whole project back as it was at ${new Date(v.savedAt).toLocaleString()}?\n\n`
      + 'Everything since then is replaced. The project as it is now is written to a '
      + 'file first, so this can be undone.', { title: 'Restore the project', confirmLabel: 'Restore' })) return;
    withVersion(v, project => { onRestoreProject(project); onClose(); });
  };

  const restoreOne = async (v: ProjectVersion, sw: VersionSwitchgear) => {
    if (!await appConfirm(
      `Put ${sw.name || 'this switchgear'} back as it was at `
      + `${new Date(v.savedAt).toLocaleString()} — ${sw.rows} row(s)?\n\n`
      + 'Nothing else in the project is touched, and the project as it is now is '
      + 'written to a file first.', { title: 'Restore a switchgear', confirmLabel: 'Restore' })) return;
    withVersion(v, project => { onRestoreSwitchgear(project, sw.id); onClose(); });
  };

  const download = (v: ProjectVersion) => withVersion(v, project => {
    const stamp = v.savedAt.slice(0, 19).replace(/[:T]/g, '-');
    downloadText(`${fileSafe(v.projectName || projectName)}-${stamp}.json`,
      JSON.stringify(project, null, 2), 'application/json');
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[10001] p-4"
      onClick={onClose}>
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-4xl max-h-[86vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-semibold text-gray-800 flex items-center gap-2">
              <HistoryIcon className="w-4 h-4 text-gray-500" />
              History of {projectName || 'this project'}
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Kept on the server, on every save. Open a version to put one switchgear back
              on its own, or put the whole project back. Either way the project as it is now
              is written to a file first.
            </p>
          </div>
          <button className="p-1 hover:bg-gray-100 rounded shrink-0" onClick={onClose}>
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <p className="px-5 py-2 text-sm text-amber-800 bg-gray-50 border-b flex items-start gap-2">
            <AlertTriangleIcon className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
            {error}
          </p>
        )}

        <div className="flex-1 overflow-y-auto">
          {versions === null && <p className="p-6 text-sm text-gray-500">Reading the history…</p>}
          {versions?.length === 0 && !error && (
            <p className="p-6 text-sm text-gray-500">
              No older versions yet. One is kept each time this project is saved over.
            </p>
          )}

          {versions && versions.length > 0 && (
            <ul className="divide-y divide-gray-100">
              {versions.map(v => (
                <li key={v._id}>
                  <div className="px-5 py-2.5 flex items-center gap-3">
                    <button
                      className="flex-1 text-left min-w-0"
                      onClick={() => setOpen(open === v._id ? null : v._id)}
                      title="Show the switchgears in this version"
                    >
                      <p className="text-sm text-gray-800">
                        {new Date(v.savedAt).toLocaleString()}
                        <span className="text-gray-400"> · {ago(v.savedAt)}</span>
                        {v.rev != null && <span className="text-gray-400"> · v{v.rev}</span>}
                      </p>
                      <p className="text-xs text-gray-500">
                        {v.counts.templates} template(s) · {v.counts.equipments} switchgear(s)
                        {' · '}{v.counts.rows} device row(s)
                      </p>
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => download(v)}
                      title="Save this version as a .json file"
                      className="px-2 py-1 rounded border border-gray-300 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      <DownloadIcon className="w-3.5 h-3.5" />
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => restoreWhole(v)}
                      className="px-2.5 py-1 rounded border border-gray-300 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap"
                    >
                      Restore all
                    </button>
                  </div>

                  {open === v._id && (
                    <div className="px-5 pb-3 bg-gray-50 border-t border-gray-100">
                      {v.counts.switchgears.length === 0 ? (
                        <p className="py-2 text-xs text-gray-500">
                          This version had no switchgears in it.
                        </p>
                      ) : (
                        <table className="w-full text-xs mt-2">
                          <tbody className="divide-y divide-gray-200">
                            {v.counts.switchgears.map(sw => (
                              <tr key={sw.id}>
                                <td className="py-1.5 pr-3 text-gray-800">{sw.name || '—'}</td>
                                <td className="py-1.5 pr-3 text-gray-500 whitespace-nowrap">{sw.type}</td>
                                <td className="py-1.5 pr-3 text-gray-500 whitespace-nowrap">
                                  {sw.rows} row(s)
                                </td>
                                <td className="py-1.5 text-right">
                                  <button
                                    disabled={busy}
                                    onClick={() => restoreOne(v, sw)}
                                    className="px-2.5 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
                                  >
                                    <RotateCcwIcon className="w-3 h-3 inline mr-1" />
                                    Restore this one
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="px-5 py-3 border-t bg-gray-50 flex items-center justify-between gap-2">
          <span className="text-xs text-gray-500">
            {versions?.length ?? 0} version(s) kept
          </span>
          <button className="px-4 py-2 text-sm bg-gray-700 text-white rounded hover:bg-gray-800"
            onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default ProjectHistoryModal;
