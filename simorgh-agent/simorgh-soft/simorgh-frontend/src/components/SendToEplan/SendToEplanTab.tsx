import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx-js-style';
import {
  SendIcon, PlugZapIcon, CheckCircle2Icon, AlertTriangleIcon, ZapIcon, DatabaseIcon, LayersIcon,
  ClipboardIcon, DownloadIcon, ListChecksIcon, SaveIcon, UploadIcon,
} from 'lucide-react';
import { useProject } from '../../context/ProjectContext';
import { buildEplanData, EplanData, EplanDataOptions } from '../../utils/eplanDataExport';
import { eplanApi, EplanTarget, EplanProject } from '../../services/eplanApi';
import { projectService } from '../../services/projectService';
import { ProjectData } from '../../types/project';
import { plotframeFieldsApi, PlotframeDrawingType } from '../../services/plotframeFieldsApi';
import { catalogFor, estimatesFor } from '../../utils/mechanical';
import { buildMechanicalReport, mechanicalReportName } from '../../utils/mechanicalReport';
import { downloadText, fileSafe } from '../../utils/download';
import { CreatingProjectSlideshow } from './CreatingProjectSlideshow';

// The "Send to EPLAN" tab — pulled out of Simorgh Draw so sending a project
// to EPLAN is its own place, not tucked inside the drawing preview. Mirrors
// Eplanix's own ProjectData screen (Project → GenerationType → its
// configuration options → Generate Switchboard) and its Mechanical screen
// (Project/Scope/Revision → Load/Export), just reached over this app's own
// eplan-bridge API instead of Eplanix's direct TCP connection, and in one
// project at a time — the project already open here — rather than a
// project/scope/revision picker of its own.

type Mode = 'project' | 'mechanical';
type GenerationType = 'sld' | 'old' | 'sldold';

const EXHAUST_OPTIONS = ['No Exhaust', 'Left Exhust', 'Right Exhaust', 'up Exhaust', 'Other'];

// Field index → a guidance label (freeform text underneath — "the labels are
// guidance only", per Eplanix's own ProjectData screen). Only 1-9 have a
// known label from the reference screen; every other index still gets a
// field, just a generic one.
const FIELD_1_9_LABELS: Record<number, string> = {
  1: 'Date', 2: 'Drawing revision', 3: 'Document status', 4: 'Tech. Expert',
  5: 'Project Resp.', 6: 'Tech. Manager', 7: 'Auth. Expert', 8: 'spare', 9: 'spare',
};
const SUBSET_STARTS = [1, 11, 21, 31, 41]; // "User supplementary fields N - N+8"
const OPTIONS_INDEXES = Array.from({ length: 21 }, (_, i) => 50 + i); // 50-70
const IDENTITY_FIELDS: { index: number; label: string; placeholder: string }[] = [
  { index: 91, label: 'Origin (Device name)', placeholder: 'e.g. B.B.1 Switchgear, 36KV, 2000A, 25KA/3S, EK3' },
  { index: 92, label: 'Replacement of (Internal document no.)', placeholder: '' },
  { index: 93, label: 'Replaced by (Customer document no.)', placeholder: '' },
  { index: 94, label: 'Macro: Version', placeholder: '00' },
];

// ── UI bits ──
//
// Defined at module scope, NOT inside SendToEplanTab. A component declared in
// the body of another is a brand-new function identity on every render, so
// React cannot match it against the previous tree: it unmounts the old node
// and mounts a fresh one each time. For a <Field> wrapping an <input> that
// meant the input was destroyed and rebuilt on every keystroke, taking focus
// with it — you had to click back into the box to type each character.
const inputCls =
  'w-full border border-gray-300 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:border-blue-400';

const ModeCard: React.FC<{
  id: Mode; icon: React.ReactNode; title: string; note: string;
  mode: Mode; onSelect: (m: Mode) => void;
}> = ({ id, icon, title, note, mode, onSelect }) => (
  <button
    onClick={() => onSelect(id)}
    className={`flex-1 text-left border-2 rounded-lg p-4 transition ${
      mode === id ? 'border-emerald-600 bg-emerald-50' : 'border-gray-200 bg-white hover:border-gray-300'
    }`}
  >
    <div className="flex items-center gap-2 mb-1">{icon}<span className="font-semibold text-gray-800">{title}</span></div>
    <p className="text-xs text-gray-500">{note}</p>
  </button>
);

// Tailwind only picks up class names that appear literally in source, so the
// active-state classes are a fixed lookup rather than built from a `color`
// prop at runtime.
const GEN_CARD_ACTIVE_CLASS: Record<GenerationType, string> = {
  sld: 'border-blue-500 bg-blue-50',
  old: 'border-amber-500 bg-amber-50',
  sldold: 'border-emerald-500 bg-emerald-50',
};

const GenCard: React.FC<{
  id: GenerationType; icon: React.ReactNode; title: string; note: string;
  generationType: GenerationType | null; onSelect: (g: GenerationType) => void;
}> = ({ id, icon, title, note, generationType, onSelect }) => (
  <button
    onClick={() => onSelect(id)}
    className={`flex-1 text-center border-2 rounded-lg p-4 transition ${
      generationType === id ? GEN_CARD_ACTIVE_CLASS[id] : 'border-gray-200 bg-white hover:border-gray-300'
    }`}
  >
    <div className="flex justify-center mb-1.5">{icon}</div>
    <p className="font-semibold text-sm text-gray-800">{title}</p>
    <p className="text-xs text-gray-500">{note}</p>
  </button>
);

const Field: React.FC<{ label: string; children: React.ReactNode; hint?: string }> = ({ label, children, hint }) => (
  <div>
    <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
    {children}
    {hint && <p className="text-[11px] text-gray-400 mt-1">{hint}</p>}
  </div>
);

const RadioPair: React.FC<{
  value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
}> = ({ value, onChange, options: opts }) => (
  <div className="flex gap-2">
    {opts.map(o => (
      <button
        key={o.value}
        onClick={() => onChange(o.value)}
        className={`px-3 py-1.5 rounded border text-sm ${
          value === o.value ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
        }`}
      >
        {o.label}
      </button>
    ))}
  </div>
);

export const SendToEplanTab: React.FC = () => {
  const {
    projectData, currentRevision, revisions, saveProject,
    isCurrentRevisionEditable, isTpmsMastered,
  } = useProject();
  const equipments = projectData.equipments ?? [];
  const withLines = equipments.filter(e => (e.devices ?? []).length > 0);

  const [equipmentId, setEquipmentId] = useState('');
  const equipment = equipments.find(e => e.id === equipmentId) || null;

  const [mode, setMode] = useState<Mode>('project');

  // ── Plotframe ──
  const [plotframeFileName, setPlotframeFileName] = useState('');
  const [suppType, setSuppType] = useState<PlotframeDrawingType>('SLD');
  const [suppSubsetStart, setSuppSubsetStart] = useState(1);
  const [suppShowOptions, setSuppShowOptions] = useState(false);
  const [sldFields, setSldFields] = useState<Record<string, string>>({});
  const [oldFields, setOldFields] = useState<Record<string, string>>({});
  const [suppStatus, setSuppStatus] = useState('');

  const projectKey = projectData._id || '';
  useEffect(() => {
    if (!projectKey || !equipmentId) { setSldFields({}); setOldFields({}); return; }
    let cancelled = false;
    (async () => {
      try {
        const [sld, old] = await Promise.all([
          plotframeFieldsApi.get(projectKey, equipmentId, 'SLD'),
          plotframeFieldsApi.get(projectKey, equipmentId, 'OLD'),
        ]);
        if (!cancelled) { setSldFields(sld); setOldFields(old); }
      } catch {
        // Saved values are a convenience — a project with none yet just
        // starts blank rather than blocking the tab.
      }
    })();
    return () => { cancelled = true; };
  }, [projectKey, equipmentId]);

  const activeFields = suppType === 'SLD' ? sldFields : oldFields;
  const setActiveFields = suppType === 'SLD' ? setSldFields : setOldFields;

  const saveSupplementaryFields = async () => {
    if (!projectKey || !equipmentId) return;
    setSuppStatus('Saving…');
    try {
      await plotframeFieldsApi.save(projectKey, equipmentId, suppType, activeFields);
      setSuppStatus('Saved.');
    } catch (err) {
      setSuppStatus((err as Error).message);
    }
  };

  // ── Drawing options ──
  const [generationType, setGenerationType] = useState<GenerationType | null>(null);
  const [isSingleCompartment, setIsSingleCompartment] = useState(false);
  const [feedersPerPage, setFeedersPerPage] = useState(6);
  const [feederDistance, setFeederDistance] = useState(0);
  const [revName, setRevName] = useState('');
  const [exhaustType, setExhaustType] = useState('');
  const [reverseFromLineNumber, setReverseFromLineNumber] = useState('');
  const [lvCompartmentHeightOld, setLvCompartmentHeightOld] = useState('70');
  const [lvCompartmentHeightSldOld, setLvCompartmentHeightSldOld] = useState('70');
  const [buffelType, setBuffelType] = useState('.1s');

  // ── Update / markup ──
  const [updateExisting, setUpdateExisting] = useState(false);
  const [markupChanged, setMarkupChanged] = useState(false);
  const [markupRevisionId, setMarkupRevisionId] = useState('');

  // ── Send ──
  const [target, setTarget] = useState<EplanTarget | null>(null);
  const [probe, setProbe] = useState<{ state: 'idle' | 'testing' | 'up' | 'down'; note?: string }>({ state: 'idle' });
  const [sending, setSending] = useState(false);
  // The slideshow while EPLAN builds it. Separate from `sending` because it
  // can be put away without stopping the job.
  const [showSlides, setShowSlides] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; projects?: EplanProject[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    eplanApi.getTarget().then(t => { if (!cancelled) setTarget(t); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const options: EplanDataOptions = useMemo(() => ({
    revision: currentRevision?.revisionNumber,
    revisionName: currentRevision?.revisionName,
    feedersPerPage,
    generationType: generationType || 'sld',
    isSingleCompartment,
    feederDistance,
    revName,
    plotframeFileName,
    exhaustType,
    reverseFromLineNumber,
    lvCompartmentHeightOld,
    lvCompartmentHeightSldOld,
    buffelType,
    updateExisting,
    markupChanged,
    sldPageUserSupplementaryFields: Object.keys(sldFields).length > 0 ? sldFields : null,
    oldPageUserSupplementaryFields: Object.keys(oldFields).length > 0 ? oldFields : null,
  }), [
    currentRevision, feedersPerPage, generationType, isSingleCompartment, feederDistance, revName,
    plotframeFileName, exhaustType, reverseFromLineNumber, lvCompartmentHeightOld, lvCompartmentHeightSldOld,
    buffelType, updateExisting, markupChanged, sldFields, oldFields,
  ]);

  const records: EplanData[] = useMemo(
    () => (equipment ? buildEplanData(projectData, [equipment], options) : []),
    [projectData, equipment, options]);

  const canSend = !!equipment && !!generationType && records.length > 0 && !sending;

  const handleTest = async () => {
    setProbe({ state: 'testing' });
    try {
      const answer = await eplanApi.ping(projectData.planner);
      setProbe(answer.reachable
        ? { state: 'up', note: answer.target ? `EPLAN is up on ${answer.target}` : 'An EPLAN instance is available' }
        : { state: 'down', note: answer.error || 'No EPLAN instance is available right now' });
    } catch (err) {
      setProbe({ state: 'down', note: (err as Error).message });
    }
  };

  const handleSend = async () => {
    setSending(true);
    setShowSlides(true);
    setResult(null);
    try {
      // EPLAN draws the project as it is kept here, in Mongo — never a fresh
      // read of TPMS. Whatever has been typed is saved first, the project is
      // read back from Mongo, the records are built from that copy and
      // stored beside it, and the send hands over the stored records. An edit
      // made in this app therefore reaches the drawing whether or not TPMS
      // has caught up with it.
      const projectId = projectData._id || '';
      const revision = currentRevision?.revisionNumber != null ? String(currentRevision.revisionNumber) : '';
      let stored: ProjectData = projectData;
      if (projectId) {
        if (isCurrentRevisionEditable && !isTpmsMastered) {
          try {
            await saveProject();
          } catch (err) {
            throw new Error(`The project could not be saved, so EPLAN would draw an older copy of it: ${(err as Error).message}`);
          }
        }
        stored = isCurrentRevisionEditable || !currentRevision?.projectSnapshot
          ? await projectService.getProjectById(projectId)
          : currentRevision.projectSnapshot;
      }
      const storedEquipment = (stored.equipments ?? []).find(e => e.id === equipment?.id) ?? equipment;

      // EPLAN draws a switchgear into a path made of the OE, the switchgear,
      // the revision and the revision name, and will not create a project
      // that is already there — the add-in fails, and what is in that folder
      // is still the drawing from before. That read as "EPLAN used the old
      // data". So a switchgear already sent at this revision and name is
      // said so first, and the send is turned into an update of that project
      // (its tables and switchboard values rewritten from these records)
      // unless somebody would rather change the revision name.
      let sendOptions = options;
      if (projectId && storedEquipment && !options.updateExisting) {
        const before = await eplanApi.getData(projectId, storedEquipment.id, revision).catch(() => null);
        const last = before?.lastSend;
        const revNameNow = (options.revName || options.revisionName || '').trim();
        if (last && last.revName.trim() === revNameNow) {
          const update = window.confirm(
            `${storedEquipment.name} was already sent to EPLAN at REV ${revision}`
            + `${revNameNow ? ` / ${revNameNow}` : ''} on ${new Date(last.at).toLocaleString()}.\n\n`
            + 'EPLAN will not create the same project twice, so a new send would leave the old '
            + 'drawing in place.\n\n'
            + 'OK — update that project with the current data (tables and switchboard values; '
            + 'the outline is not redrawn in update mode).\n'
            + 'Cancel — stop, to change the revision name or remove the old project first.');
          if (!update) {
            setResult({ ok: false, text: 'Not sent — change the revision name, or tick "Update existing project".' });
            return;
          }
          setUpdateExisting(true);
          sendOptions = { ...options, updateExisting: true };
        }
      }

      const data = storedEquipment ? buildEplanData(stored, [storedEquipment], sendOptions) : [];
      if (data.length === 0) throw new Error('This switchgear has no feeder lines in the saved project.');

      let answer;
      if (projectId && storedEquipment) {
        await eplanApi.storeData({
          projectId, equipmentId: storedEquipment.id, revision,
          scopeName: storedEquipment.name, records: data,
        });
        answer = await eplanApi.send({
          projectName: stored.projectName,
          userName: stored.planner,
          projectId, equipmentId: storedEquipment.id, revision,
        });
      } else {
        // A project that has never been saved has no Mongo copy to send.
        answer = await eplanApi.send({
          projectName: projectData.projectName,
          data,
          userName: projectData.planner,
        });
      }
      setResult(answer.success
        ? { ok: true,
            text: answer.message || `${records.length} record(s) sent.`,
            projects: answer.projects }
        : { ok: false, text: answer.error || 'The EPLAN bridge did not accept the records.' });
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setSending(false);
      // Whether it worked or not, the answer is the thing to look at now.
      setShowSlides(false);
    }
  };

  const downloadErrorLog = () => {
    if (!result) return;
    const log = {
      when: new Date().toISOString(),
      project: projectData.projectName,
      revision: currentRevision?.revisionNumber,
      switchgear: equipment?.name,
      target: target?.url,
      generationType,
      error: result.text,
      records: records.length,
      firstRecord: records[0] ?? null,
    };
    downloadText(
      `${fileSafe(projectData.projectName)}_${fileSafe(equipment?.name || 'send')}_eplan_error.json`,
      JSON.stringify(log, null, 2), 'application/json');
  };

  // ── Mechanical (matches Eplanix's own Mechanical screen: pick a
  // switchgear, load the items, export — no TCP send involved) ──
  //
  // What is counted here is what the report will hold: the estimate sheets
  // read against each feeder as Eplanix reads them. It used to be a different
  // list — the one this app derives from the panel specification — so the
  // count on screen was not the count in the file, and the button went dead
  // on a switchgear whose specification was thin even when the sheets had
  // plenty to say about it.
  const mechanical = useMemo(() => {
    if (!equipment) return { cells: 0, items: 0, sheet: '', why: '' };
    const estimates = estimatesFor(projectData, equipment);
    const items = estimates.reduce((n, e) =>
      n + e.equipment.reduce((q, x) => q + x.quantity, 0), 0);
    return {
      cells: estimates.length,
      items,
      sheet: catalogFor(estimates[0]?.context.panelType ?? '')?.panelType ?? '',
      why: items === 0 ? (estimates.find(e => e.note)?.note ?? '') : '',
    };
  }, [projectData, equipment]);

  /**
   * The mechanical report, in the shape Eplanix issues one.
   *
   * Not a sheet of rows any more: the same six sheets its Mechanical screen
   * produces — cover, overview, equipment summary, per-cell data, the cell ×
   * part matrix and the panel elevation — built from this project's own
   * feeders, templates and panel specification. See `mechanicalReport.ts` for
   * what was taken from that routine and what deliberately was not.
   */
  const exportMechanicalExcel = () => {
    if (!equipment) return;
    const cells = equipment.devices ?? [];
    if (cells.length === 0) {
      alert('Nothing to report yet — this switchgear has no feeders in Device Selection.');
      return;
    }
    const revision = currentRevision?.revisionNumber ? String(currentRevision.revisionNumber) : '';
    XLSX.writeFile(
      buildMechanicalReport(projectData, equipment, revision),
      mechanicalReportName(projectData, equipment, revision),
    );
  };


  return (
    <div>
      {/* The wait, while EPLAN builds the project. Minutes of it, so there is
          something to watch and something to read. */}
      <CreatingProjectSlideshow
        open={sending && showSlides}
        projectName={projectData.projectName}
        switchgear={equipment?.name ?? ''}
        generationType={generationType || ''}
        recordCount={records.length}
        onHide={() => setShowSlides(false)}
      />

      <div className="mb-5">
        <h2 className="text-xl font-bold text-gray-800">Send to EPLAN</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          {projectData.projectName}{currentRevision ? ` — REV ${currentRevision.revisionNumber}` : ''} — pick one
          switchgear, then Project (single line / outline drawings) or Mechanical (items list).
        </p>
      </div>

      {/* ── Switchgear (required, one at a time) ── */}
      <div className="border border-gray-200 rounded-lg p-4 mb-5 bg-gray-50">
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Switchgear</label>
        <select
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-full max-w-md focus:outline-none focus:border-blue-400"
          value={equipmentId}
          onChange={e => setEquipmentId(e.target.value)}
        >
          <option value="">— Select a switchgear —</option>
          {equipments.map(eq => (
            <option key={eq.id} value={eq.id}>
              {eq.name} — {eq.type} ({(eq.devices ?? []).length} feeders)
            </option>
          ))}
        </select>
        {withLines.length === 0 && (
          <p className="text-xs text-amber-700 mt-2">No switchgear has feeder lines yet — add them in Device Selection first.</p>
        )}
      </div>

      {!equipmentId ? (
        <p className="text-sm text-gray-500 px-1">Select a switchgear above to continue.</p>
      ) : (
        <>
          {/* ── Project vs Mechanical ── */}
          <div className="flex gap-3 mb-5">
            <ModeCard mode={mode} onSelect={setMode} id="project" icon={<ZapIcon className="w-4 h-4 text-emerald-700" />} title="Project"
              note="Single line and/or outline drawings, sent to EPLAN" />
            <ModeCard mode={mode} onSelect={setMode} id="mechanical" icon={<ClipboardIcon className="w-4 h-4 text-amber-700" />} title="Mechanical"
              note="Mechanical items list — Load and Export only, nothing is sent to EPLAN" />
          </div>

          {mode === 'mechanical' && (
            <div className="border border-gray-200 rounded-lg">
              <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm text-gray-800">
                    {mechanical.items} item(s) across {mechanical.cells} cell(s) — {equipment?.name}
                  </p>
                  <p className="text-xs text-gray-500">
                    {mechanical.sheet
                      ? `Read off the ${mechanical.sheet} estimate sheet, cell by cell.`
                      : 'Read off the estimate sheet for this panel type, cell by cell.'}
                  </p>
                </div>
                <button
                  onClick={exportMechanicalExcel}
                  disabled={mechanical.cells === 0}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg shadow-sm font-medium text-sm bg-amber-700 text-white hover:bg-amber-800 disabled:opacity-40"
                >
                  <DownloadIcon className="w-4 h-4" /> Export Mechanical Excel
                </button>
              </div>
              {mechanical.items === 0 && (
                <p className="p-6 text-sm text-gray-500">
                  {mechanical.why
                    || 'Nothing to list yet — add the feeders in Device Selection first.'}
                </p>
              )}
            </div>
          )}

          {mode === 'project' && (
            <div className="space-y-5">
              {/* ── Plotframe ── */}
              <div className="border border-gray-200 rounded-lg p-4">
                <Field label="Upload Plotframe Macro (.ema)"
                  hint="Captured as a filename reference on the send payload — the file itself still needs to reach the EPLAN machine by whatever means the office already uses for macros; this tab does not transfer its bytes yet.">
                  <label className="flex items-center gap-2 border border-gray-300 rounded px-3 py-2 text-sm cursor-pointer hover:bg-gray-50 w-fit">
                    <UploadIcon className="w-4 h-4 text-gray-500" />
                    <span className="text-gray-700">{plotframeFileName || 'Choose file…'}</span>
                    <input type="file" accept=".ema" className="hidden"
                      onChange={e => setPlotframeFileName(e.target.files?.[0]?.name || '')} />
                  </label>
                </Field>

                <div className="mt-4 border border-gray-200 rounded-lg p-3 bg-gray-50">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
                      <ListChecksIcon className="w-4 h-4 text-gray-500" /> Plotframe User supplementary fields
                    </span>
                    <span className="text-xs text-gray-400">{suppStatus}</span>
                  </div>
                  <div className="flex gap-1.5 mb-2">
                    {(['SLD', 'OLD'] as const).map(t => (
                      <button key={t} onClick={() => setSuppType(t)}
                        className={`px-3 py-1 rounded text-xs font-medium ${
                          suppType === t ? 'bg-blue-600 text-white' : 'bg-white border border-gray-300 text-gray-600'
                        }`}>
                        {t}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-gray-500 mb-3">
                    The labels are guidance only — replace each one with the actual value for this plotframe. Values
                    are kept separately per switchgear and per drawing type ({suppType} here).
                  </p>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                    {IDENTITY_FIELDS.map(f => (
                      <Field key={f.index} label={f.label}>
                        <input className={inputCls} placeholder={f.placeholder}
                          value={activeFields[String(f.index)] || ''}
                          onChange={e => setActiveFields(prev => ({ ...prev, [String(f.index)]: e.target.value }))} />
                      </Field>
                    ))}
                  </div>

                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-gray-600">
                      User supplementary fields {suppSubsetStart} - {suppSubsetStart + 8}
                    </span>
                    <div className="flex gap-1">
                      <button className="px-2 py-0.5 border rounded text-xs hover:bg-gray-100"
                        disabled={SUBSET_STARTS.indexOf(suppSubsetStart) <= 0}
                        onClick={() => setSuppSubsetStart(SUBSET_STARTS[Math.max(0, SUBSET_STARTS.indexOf(suppSubsetStart) - 1)])}>
                        −
                      </button>
                      <button className="px-2 py-0.5 border rounded text-xs hover:bg-gray-100"
                        disabled={SUBSET_STARTS.indexOf(suppSubsetStart) >= SUBSET_STARTS.length - 1}
                        onClick={() => setSuppSubsetStart(SUBSET_STARTS[Math.min(SUBSET_STARTS.length - 1, SUBSET_STARTS.indexOf(suppSubsetStart) + 1)])}>
                        +
                      </button>
                      <button className="px-2 py-0.5 border rounded text-xs text-blue-700 hover:bg-blue-50"
                        onClick={() => setSuppShowOptions(v => !v)}>
                        {suppShowOptions ? 'Hide Options' : 'Options (50-70)'}
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {Array.from({ length: 9 }, (_, i) => suppSubsetStart + i).map(idx => (
                      <Field key={idx} label={`${idx} — ${FIELD_1_9_LABELS[idx] || `Field ${idx}`}`}>
                        <input className={inputCls}
                          value={activeFields[String(idx)] || ''}
                          onChange={e => setActiveFields(prev => ({ ...prev, [String(idx)]: e.target.value }))} />
                      </Field>
                    ))}
                  </div>

                  {suppShowOptions && (
                    <div className="mt-3 pt-3 border-t">
                      <p className="text-xs font-medium text-gray-600 mb-2">Options — fields 50 & 60-70</p>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        {OPTIONS_INDEXES.map(idx => (
                          <Field key={idx} label={`${idx}`}>
                            <input className={inputCls}
                              value={activeFields[String(idx)] || ''}
                              onChange={e => setActiveFields(prev => ({ ...prev, [String(idx)]: e.target.value }))} />
                          </Field>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="mt-3 text-right">
                    <button onClick={saveSupplementaryFields}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-emerald-700 text-white hover:bg-emerald-800 ml-auto">
                      <SaveIcon className="w-3.5 h-3.5" /> Save {suppType} supplementary fields
                    </button>
                  </div>
                </div>
              </div>

              {/* ── Drawing Options ── */}
              <div className="border border-gray-200 rounded-lg p-4">
                <p className="text-sm font-semibold text-gray-700 mb-3">Drawing Options</p>
                <div className="flex gap-3 mb-4">
                  <GenCard generationType={generationType} onSelect={setGenerationType} id="sld" icon={<ZapIcon className="w-5 h-5 text-blue-600" />} title="Generate SLD"
                    note="Single Line Diagram" />
                  <GenCard generationType={generationType} onSelect={setGenerationType} id="old" icon={<DatabaseIcon className="w-5 h-5 text-amber-600" />} title="Generate OLD"
                    note="Outline Drawing" />
                  <GenCard generationType={generationType} onSelect={setGenerationType} id="sldold" icon={<LayersIcon className="w-5 h-5 text-emerald-600" />} title="Generate SLD & OLD"
                    note="Both Diagrams" />
                </div>

                {generationType && (
                  <div className="border-l-4 border-blue-400 bg-blue-50/40 rounded p-4 space-y-3">
                    <label className="flex items-center gap-2 text-sm text-gray-700">
                      <input type="checkbox" checked={isSingleCompartment}
                        onChange={e => setIsSingleCompartment(e.target.checked)} />
                      Side Plotframe
                    </label>

                    {(generationType === 'sld' || generationType === 'sldold') && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Field label={`Number of feeders per page (max 6${generationType === 'sld' ? ' — only for SLD' : ''})`}>
                          <select className={inputCls} value={feedersPerPage} onChange={e => setFeedersPerPage(Number(e.target.value))}>
                            {[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n} feeder{n > 1 ? 's' : ''}</option>)}
                          </select>
                        </Field>
                        <Field label={`Distance between feeders (mm${generationType === 'sld' ? ' — only for SLD' : ''})`}>
                          <input type="number" className={inputCls} value={feederDistance}
                            onChange={e => setFeederDistance(Number(e.target.value))} />
                        </Field>
                      </div>
                    )}

                    {(generationType === 'old' || generationType === 'sldold') && (
                      <>
                        <Field label="Exhaust Type">
                          <select className={inputCls} value={exhaustType} onChange={e => setExhaustType(e.target.value)}>
                            <option value="">-- Select Exhaust Type --</option>
                            {EXHAUST_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                          </select>
                        </Field>
                        <Field label="Reverse From Line Number (OLD placement)"
                          hint="If set, lines before this number are placed normally, and lines from this number to the end are placed in reverse order.">
                          <input className={inputCls} placeholder="e.g. L7 (optional — leave empty for normal order)"
                            value={reverseFromLineNumber} onChange={e => setReverseFromLineNumber(e.target.value)} />
                        </Field>
                        <Field label="LV Compartment Height (AIS-SIMOPRIME-WORLD)">
                          <RadioPair
                            value={generationType === 'old' ? lvCompartmentHeightOld : lvCompartmentHeightSldOld}
                            onChange={v => (generationType === 'old' ? setLvCompartmentHeightOld(v) : setLvCompartmentHeightSldOld(v))}
                            options={[{ value: '70', label: '70 cm' }, { value: '100', label: '100 cm' }]}
                          />
                        </Field>
                        <Field label="Buffel (AIS-SIMOPRIME-WORLD)">
                          <RadioPair value={buffelType} onChange={setBuffelType}
                            options={[{ value: '.1s', label: '.1s' }, { value: '1s', label: '1s' }]} />
                        </Field>
                      </>
                    )}

                    <Field label="Internal Revision Number">
                      <input className={inputCls} placeholder="Enter revision number" value={revName}
                        onChange={e => setRevName(e.target.value)} />
                    </Field>
                  </div>
                )}
              </div>

              {/* ── Update / markup ── */}
              <div className="border border-gray-200 rounded-lg p-4 space-y-3">
                <p className="text-sm font-semibold text-gray-700">If this project already exists on EPLAN</p>
                <label className="flex items-start gap-2 text-sm text-gray-700">
                  <input type="checkbox" className="mt-0.5" checked={updateExisting}
                    onChange={e => setUpdateExisting(e.target.checked)} />
                  <span>
                    <span className="font-medium">Update existing project</span> — refresh the table header and part
                    properties on the project already on EPLAN, instead of creating a new one.
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm text-gray-700">
                  <input type="checkbox" className="mt-0.5" checked={markupChanged}
                    onChange={e => setMarkupChanged(e.target.checked)} />
                  <span>
                    <span className="font-medium">Markup changes</span> — tell EPLAN this send carries changes versus
                    a previous revision, comparing against:
                  </span>
                </label>
                {markupChanged && (
                  <select className={`${inputCls} max-w-xs ml-6`} value={markupRevisionId}
                    onChange={e => setMarkupRevisionId(e.target.value)}>
                    <option value="">— Select a revision to compare against —</option>
                    {revisions.filter(r => r._id !== currentRevision?._id).map(r => (
                      <option key={r._id} value={r._id}>REV {r.revisionNumber} — {r.revisionName}</option>
                    ))}
                  </select>
                )}
                <p className="text-[11px] text-gray-400">
                  Neither box checked, on a project that already exists, asks EPLAN to recreate it from scratch —
                  same as leaving both unchecked in Eplanix's own dialog.
                </p>
              </div>

              {/* ── Target + send ── */}
              <div className="border border-gray-200 rounded-lg p-4">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div className="text-sm min-w-0">
                    <p className="text-gray-800 truncate">{target ? target.url : 'Reading the configured EPLAN bridge…'}</p>
                    <p className="text-xs text-gray-500">{records.length} record(s) for {equipment?.name}</p>
                  </div>
                  <button
                    className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 rounded text-sm hover:bg-gray-50 disabled:opacity-40"
                    onClick={handleTest} disabled={probe.state === 'testing'}
                  >
                    <PlugZapIcon className="w-4 h-4" /> {probe.state === 'testing' ? 'Testing…' : 'Test'}
                  </button>
                </div>
                {probe.state === 'up' && (
                  <p className="text-xs text-emerald-700 mb-2 flex items-center gap-1"><CheckCircle2Icon className="w-3.5 h-3.5" /> {probe.note}</p>
                )}
                {probe.state === 'down' && (
                  <p className="text-xs text-red-600 mb-2 flex items-center gap-1"><AlertTriangleIcon className="w-3.5 h-3.5" /> {probe.note}</p>
                )}

                {result && (
                  <div className={`rounded-lg px-3 py-2 text-sm mb-3 flex items-center justify-between gap-3 ${
                    result.ok ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'
                  }`}>
                    <span>{result.text}</span>
                    {!result.ok && (
                      <button onClick={downloadErrorLog}
                        className="shrink-0 flex items-center gap-1 text-xs underline hover:no-underline">
                        <DownloadIcon className="w-3.5 h-3.5" /> Download error log
                      </button>
                    )}
                  </div>
                )}

                {/* What EPLAN produced. Plain links, not fetch(): a project
                    archive runs to hundreds of megabytes, and letting the
                    browser stream it to disk gives the normal download UI and
                    keeps it out of this tab's memory. A send that generated
                    both SLD and OLD lists each separately. */}
                {result?.ok && result.projects && result.projects.length > 0 && (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 mb-3">
                    <p className="text-xs font-medium text-slate-600 mb-2">
                      Ready on the techserver
                    </p>
                    <div className="space-y-2">
                      {result.projects.map(project => (
                        <div key={`${project.type}-${project.path}`}
                          className="flex items-center justify-between gap-3 flex-wrap">
                          <span className="text-sm text-slate-700">
                            {project.displayName}
                            <span className="text-xs text-slate-400 ml-2">
                              {project.oenum} / {project.fileName}
                            </span>
                          </span>
                          <span className="flex items-center gap-2 shrink-0">
                            <a href={eplanApi.downloadUrl(project, 'pdf')}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-100">
                              <DownloadIcon className="w-3.5 h-3.5" /> PDF
                            </a>
                            <a href={eplanApi.downloadUrl(project, 'zip')}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-100">
                              <DownloadIcon className="w-3.5 h-3.5" /> Project (.zip)
                            </a>
                          </span>
                        </div>
                      ))}
                    </div>
                    <p className="text-[11px] text-slate-400 mt-2">
                      The archive is the .elk and its .edb folder, zipped on the way through — it can take a while.
                    </p>
                  </div>
                )}

                {!generationType && <p className="text-xs text-amber-700 mb-2">Choose Generate SLD / OLD / SLD &amp; OLD above first.</p>}

                <div className="text-center">
                  <button
                    onClick={handleSend}
                    disabled={!canSend}
                    className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg shadow-sm font-medium text-sm bg-red-600 text-white hover:bg-red-700 disabled:opacity-40"
                  >
                    <SendIcon className="w-4 h-4" /> {sending ? 'Sending…' : 'Create Project'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
