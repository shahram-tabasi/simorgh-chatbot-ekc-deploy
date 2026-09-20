import React, { useEffect, useState } from 'react';
import { DatabaseIcon, XIcon, CheckCircleIcon, AlertTriangleIcon } from 'lucide-react';
import { tpmsService, TpmsOption } from '../../services/projectService';
import { useProject } from '../../context/ProjectContext';
import { buildTpmsImport, TpmsPayload, TpmsImportOptions } from '../../utils/tpmsImport';

interface TpmsImportModalProps {
  onClose: () => void;
  /** Called with the imported switchgear's id, so the caller can select it. */
  onImported?: (equipmentId?: string) => void;
}

const OPTION_LABELS: { key: keyof TpmsImportOptions; label: string; hint: string }[] = [
  { key: 'projectData',   label: 'Project data',    hint: 'OE number, name, planner, design office' },
  { key: 'techSettings',  label: 'Technical settings', hint: 'Altitude, temperature, wire sizes and colours' },
  { key: 'deviceLibrary', label: 'Device Library entry', hint: 'The panel specification as a device' },
  { key: 'equipment',     label: 'Switchgear & lines',  hint: 'Feeder lines in Device Selection, plus their templates' },
];

// Pull a switchgear out of TPMS — the same MySQL data Eplanix reads — and put
// it where it belongs in this project: master data, technical settings, a
// Device Library entry, and the switchgear with a row per feeder line and the
// templates carrying its parts.
export const TpmsImportModal: React.FC<TpmsImportModalProps> = ({ onClose, onImported }) => {
  const { projectData, updateProjectData, setSelectedEquipment, isCurrentRevisionEditable, notifyRevisionLocked } = useProject();

  const [projects, setProjects] = useState<TpmsOption[]>([]);
  const [scopes, setScopes] = useState<TpmsOption[]>([]);
  const [revisions, setRevisions] = useState<TpmsOption[]>([]);
  const [projectId, setProjectId] = useState<number | ''>('');
  const [scopeId, setScopeId] = useState<number | ''>('');
  const [revisionId, setRevisionId] = useState<number | ''>('');

  const [loading, setLoading] = useState<string | null>('projects');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<TpmsPayload | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [options, setOptions] = useState<TpmsImportOptions>({
    projectData: true, techSettings: true, deviceLibrary: true, equipment: true,
  });

  useEffect(() => {
    tpmsService.getProjects()
      .then(items => { setProjects(items); setError(null); })
      .catch(err => setError(err.message))
      .finally(() => setLoading(null));
  }, []);

  const pickProject = async (value: number) => {
    setProjectId(value); setScopeId(''); setRevisionId('');
    setScopes([]); setRevisions([]); setPreview(null); setDone(null);
    setLoading('scopes');
    try {
      setScopes(await tpmsService.getScopes(value));
      setError(null);
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(null); }
  };

  const pickScope = async (value: number) => {
    setScopeId(value); setRevisionId(''); setRevisions([]); setPreview(null); setDone(null);
    setLoading('revisions');
    try {
      const items = await tpmsService.getRevisions(value);
      setRevisions(items);
      // Newest revision first — that is the one people almost always want.
      if (items.length > 0) {
        const newest = items.reduce((a, b) => (Number(b.value) > Number(a.value) ? b : a));
        setRevisionId(Number(newest.value));
      }
      setError(null);
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(null); }
  };

  const loadPreview = async () => {
    if (projectId === '' || scopeId === '') return;
    setLoading('preview'); setPreview(null); setDone(null);
    try {
      const payload = await tpmsService.getImport(
        Number(projectId), Number(scopeId), revisionId === '' ? null : Number(revisionId));
      setPreview(payload);
      setError(null);
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(null); }
  };

  const runImport = () => {
    if (!preview) return;
    if (!isCurrentRevisionEditable) { notifyRevisionLocked(); return; }

    const { patch, equipmentId, summary } = buildTpmsImport(projectData, preview, options);
    updateProjectData(patch);

    if (equipmentId) {
      const imported = (patch.equipments ?? []).find(eq => eq.id === equipmentId);
      if (imported) setSelectedEquipment(imported);
    }
    setDone(
      `${summary.rows} line${summary.rows === 1 ? '' : 's'} · ` +
      `${summary.templates} template${summary.templates === 1 ? '' : 's'} · ` +
      `${summary.parts} part${summary.parts === 1 ? '' : 's'}` +
      (summary.replacedEquipment ? ' — the switchgear already here was refreshed' : ''),
    );
    onImported?.(equipmentId);
  };

  // A revision is not required. A panel TPMS holds none for yet is a real
  // panel with a real specification and no feeder lines drawn up — the
  // engineer carries on from here, enters the rest, and the switchgear is in
  // the Device Library to build templates against. Demanding a revision left
  // them with a dialog that could not be pressed.
  const ready = projectId !== '' && scopeId !== '';
  const noRevisions = scopeId !== '' && revisions.length === 0 && loading !== 'revisions';
  const selectClass = 'w-full border border-gray-400 rounded px-3 py-2 text-sm bg-white disabled:bg-gray-100 disabled:text-gray-400';

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[100] p-6">
      <div className="bg-white rounded-lg shadow-2xl w-[820px] max-w-full max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between px-6 py-4 border-b bg-sky-50 rounded-t-lg">
          <div className="flex items-start gap-3">
            <DatabaseIcon className="w-6 h-6 text-sky-700 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-semibold text-lg text-sky-900">Import from TPMS</h3>
              <p className="text-sm text-sky-800 mt-0.5">
                The same switchgear data Simorgh Draw reads — project, panel specification, feeder lines and their parts.
              </p>
            </div>
          </div>
          <button className="p-1 hover:bg-sky-100 rounded" onClick={onClose}>
            <XIcon className="w-5 h-5 text-sky-700" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0 space-y-4">
          {error && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-300 text-red-800 text-sm px-4 py-2.5 rounded">
              <AlertTriangleIcon className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Project (OE)</label>
              <select
                className={selectClass}
                value={projectId}
                disabled={loading === 'projects'}
                onChange={e => pickProject(Number(e.target.value))}
              >
                <option value="">{loading === 'projects' ? 'Loading…' : '-- Select project --'}</option>
                {projects.map(p => <option key={p.value} value={p.value}>{p.text}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Switchgear</label>
              <select
                className={selectClass}
                value={scopeId}
                disabled={projectId === '' || loading === 'scopes'}
                onChange={e => pickScope(Number(e.target.value))}
              >
                <option value="">{loading === 'scopes' ? 'Loading…' : '-- Select switchgear --'}</option>
                {scopes.map(s => <option key={s.value} value={s.value}>{s.text}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Revision</label>
              <select
                className={selectClass}
                value={revisionId}
                disabled={scopeId === '' || loading === 'revisions'}
                onChange={e => {
                  setRevisionId(e.target.value === '' ? '' : Number(e.target.value));
                  setPreview(null); setDone(null);
                }}
              >
                <option value="">
                  {loading === 'revisions' ? 'Loading…'
                    : noRevisions ? 'No revision yet — bring in the specification'
                    : 'No revision — specification only'}
                </option>
                {revisions.map(r => <option key={r.value} value={r.value}>Rev {r.text}</option>)}
              </select>
              {/* Said where the choice is made, because "no revision" reads as
                  a mistake until somebody says it is not one. */}
              {scopeId !== '' && revisionId === '' && loading !== 'revisions' && (
                <p className="mt-1 text-[11px] text-gray-500">
                  {noRevisions
                    ? 'TPMS has no revision for this switchgear. Its specification comes in and the feeder lines are yours to enter.'
                    : 'The specification comes in without any feeder lines.'}
                </p>
              )}
            </div>
          </div>

          {!preview && (
            <button
              className="px-4 py-2 bg-sky-700 text-white rounded text-sm hover:bg-sky-800 disabled:opacity-40"
              disabled={!ready || loading === 'preview'}
              onClick={loadPreview}
            >
              {loading === 'preview' ? 'Reading TPMS…' : 'Read this switchgear'}
            </button>
          )}

          {preview && (
            <>
              <div className="border border-gray-200 rounded overflow-hidden">
                <div className="px-4 py-2 bg-gray-50 border-b text-sm font-medium text-gray-700">
                  What TPMS has
                </div>
                <div className="grid grid-cols-2 gap-x-8 gap-y-1 px-4 py-3 text-sm">
                  {[
                    ['Project', `${preview.project.oeNumber} ${preview.project.projectName}`.trim()],
                    ['Switchgear', `${preview.scope.scopeName}${preview.scope.switchgearType ? ` — ${preview.scope.switchgearType}` : ''}`],
                    ['Voltage level', preview.scope.panelType],
                    ['Revision', preview.scope.revision == null
                      ? 'None — specification only' : `Rev ${preview.scope.revision}`],
                    ['Feeder lines', String(preview.counts.lines)],
                    ['Parts on those lines', String(preview.counts.parts)],
                    ['Cells', preview.scope.cellCount || '—'],
                    ['Project expert', preview.project.projectExpert || '—'],
                  ].map(([label, value]) => (
                    <div key={label} className="flex gap-2 py-0.5 border-b border-gray-50">
                      <span className="w-40 text-gray-500 flex-shrink-0">{label}</span>
                      <span className="text-gray-800 font-medium truncate" title={value}>{value || '—'}</span>
                    </div>
                  ))}
                </div>

                {preview.lines.length > 0 && (
                  <div className="max-h-48 overflow-y-auto border-t border-gray-100">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 sticky top-0">
                        <tr className="text-gray-500">
                          <th className="px-3 py-1.5 text-left font-medium">Bus</th>
                          <th className="px-3 py-1.5 text-left font-medium">Feeder</th>
                          <th className="px-3 py-1.5 text-left font-medium">Type</th>
                          <th className="px-3 py-1.5 text-left font-medium">Power</th>
                          <th className="px-3 py-1.5 text-left font-medium">FLC</th>
                          <th className="px-3 py-1.5 text-left font-medium">Description</th>
                          <th className="px-3 py-1.5 text-right font-medium">Parts</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.lines.map(line => (
                          <tr key={line.draftId} className="border-t border-gray-100">
                            <td className="px-3 py-1 text-gray-600">{line.busSection || '—'}</td>
                            <td className="px-3 py-1 text-gray-800 font-medium">{line.feederNo || '—'}</td>
                            <td className="px-3 py-1 text-gray-600">{line.wiringType || '—'}</td>
                            <td className="px-3 py-1 text-gray-600">{line.ratingPower || '—'}</td>
                            <td className="px-3 py-1 text-gray-600">{line.flc || '—'}</td>
                            <td className="px-3 py-1 text-gray-600 truncate max-w-[220px]" title={line.description}>
                              {line.description || '—'}
                            </td>
                            <td className="px-3 py-1 text-right text-gray-500">
                              {Object.values(line.parts).reduce((n, p) => n + p.length, 0)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">What to bring in</p>
                <div className="grid grid-cols-2 gap-2">
                  {OPTION_LABELS.map(({ key, label, hint }) => (
                    <label
                      key={key}
                      className={`flex items-start gap-2 border rounded px-3 py-2 cursor-pointer ${
                        options[key] ? 'border-sky-400 bg-sky-50' : 'border-gray-200'
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-sky-600"
                        checked={options[key]}
                        onChange={e => setOptions(prev => ({ ...prev, [key]: e.target.checked }))}
                      />
                      <span>
                        <span className="block text-sm text-gray-800">{label}</span>
                        <span className="block text-xs text-gray-500">{hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <p className="text-xs text-gray-500">
                Nothing else in the project is touched. Importing this switchgear again refreshes
                its rows and its library entry rather than adding a second copy.
              </p>

              {done && (
                <div className="flex items-start gap-2 bg-green-50 border border-green-300 text-green-800 text-sm px-4 py-2.5 rounded">
                  <CheckCircleIcon className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>Imported: {done}</span>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t bg-gray-50 rounded-b-lg">
          <span className="text-xs text-gray-400">Read-only — nothing is written back to TPMS.</span>
          <div className="flex gap-2">
            <button className="px-4 py-2 border rounded text-sm hover:bg-gray-100" onClick={onClose}>
              {done ? 'Close' : 'Cancel'}
            </button>
            <button
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-40"
              disabled={!preview || !Object.values(options).some(Boolean)}
              onClick={runImport}
            >
              {done ? 'Import again' : 'Import'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
