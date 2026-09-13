import React, { useEffect, useMemo, useState } from 'react';
import { SendIcon, XIcon, PlugZapIcon, CheckCircle2Icon, AlertTriangleIcon, CopyIcon } from 'lucide-react';
import { ProjectData, Equipment, Revision } from '../../types/project';
import { buildEplanData, EplanData } from '../../utils/eplanDataExport';
import { eplanApi, EplanTarget } from '../../services/eplanApi';

// "Send to EPLAN": the project's feeder lines as EplanData records, posted
// through this app's backend to eplan-bridge-service, which holds the
// actual TCP connection to EPLAN's listener and picks a port from the pool
// — the same thing Eplanix's own TcpPortResolverService does for its own
// users, just reached from a different server. There is nothing to address
// here: the bridge's location is an ops setting (EPLAN_BRIDGE_URL on this
// app's backend), not something a single send should override.

interface Props {
  projectData: ProjectData;
  equipments: Equipment[];
  currentRevision?: Revision | null;
  feedersPerPage: number;
  onClose: () => void;
}

export const SendToEplanDialog: React.FC<Props> = ({
  projectData, equipments, currentRevision, feedersPerPage, onClose,
}) => {
  const [target, setTarget] = useState<EplanTarget | null>(null);
  const [probe, setProbe] = useState<{ state: 'idle' | 'testing' | 'up' | 'down'; note?: string }>({ state: 'idle' });
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [showPayload, setShowPayload] = useState(false);

  useEffect(() => {
    let cancelled = false;
    eplanApi.getTarget()
      .then(t => { if (!cancelled) setTarget(t); })
      .catch(() => { /* shown as "not configured" below */ });
    return () => { cancelled = true; };
  }, []);

  const records: EplanData[] = useMemo(
    () => buildEplanData(projectData, equipments, {
      revision: currentRevision?.revisionNumber,
      revisionName: currentRevision?.revisionName,
      feedersPerPage,
    }),
    [projectData, equipments, currentRevision, feedersPerPage]);

  const withLines = equipments.filter(eq => (eq.devices ?? []).length > 0);
  const canSend = records.length > 0 && !sending;

  const handleTest = async () => {
    setProbe({ state: 'testing' });
    setResult(null);
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
    setResult(null);
    try {
      const answer = await eplanApi.send({
        projectName: projectData.projectName,
        data: records,
        userName: projectData.planner,
      });
      setResult(answer.success
        ? { ok: true, text: answer.message || `${records.length} record(s) sent.` }
        : { ok: false, text: answer.error || 'The EPLAN bridge did not accept the records.' });
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setSending(false);
    }
  };

  const preview = JSON.stringify(records.slice(0, 1), null, 2);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-2xl w-[720px] max-h-[90vh] flex flex-col">

        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div>
            <h3 className="font-semibold text-lg flex items-center gap-2">
              <SendIcon className="w-4 h-4 text-emerald-700" /> Send to EPLAN
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {projectData.projectName}
              {currentRevision ? ` — REV ${currentRevision.revisionNumber}` : ''}
            </p>
          </div>
          <button className="p-1 hover:bg-gray-100 rounded" onClick={onClose} title="Close">
            <XIcon className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5 min-h-0">

          {/* ── Where it goes ── */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Target</p>
            <div className="flex items-center justify-between gap-3 border border-gray-200 rounded-lg px-3 py-2">
              <div className="text-sm min-w-0">
                <p className="text-gray-800 truncate">
                  {target ? target.url : 'Reading the configured EPLAN bridge…'}
                </p>
                <p className="text-xs text-gray-500">
                  Which EPLAN instance a send lands on is picked by the bridge itself — set once for this
                  deployment, not per send.
                </p>
              </div>
              <button
                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 rounded text-sm hover:bg-gray-50 disabled:opacity-40"
                onClick={handleTest}
                disabled={probe.state === 'testing'}
              >
                <PlugZapIcon className="w-4 h-4" />
                {probe.state === 'testing' ? 'Testing…' : 'Test'}
              </button>
            </div>
            {probe.state === 'up' && (
              <p className="text-xs text-emerald-700 mt-1 flex items-center gap-1">
                <CheckCircle2Icon className="w-3.5 h-3.5" /> {probe.note}
              </p>
            )}
            {probe.state === 'down' && (
              <p className="text-xs text-red-600 mt-1 flex items-center gap-1">
                <AlertTriangleIcon className="w-3.5 h-3.5" /> {probe.note}
              </p>
            )}
          </div>

          {/* ── What goes ── */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Payload</p>
            <div className="border border-gray-200 rounded-lg divide-y text-sm">
              <div className="flex justify-between px-3 py-2">
                <span className="text-gray-600">Switchgears with feeder lines</span>
                <strong>{withLines.length} of {equipments.length}</strong>
              </div>
              <div className="flex justify-between px-3 py-2">
                <span className="text-gray-600">EplanData records (one per feeder)</span>
                <strong>{records.length}</strong>
              </div>
              <div className="flex justify-between px-3 py-2">
                <span className="text-gray-600">Feeders per drawing sheet</span>
                <strong>{feedersPerPage}</strong>
              </div>
            </div>
            {withLines.length > 0 && (
              <p className="text-xs text-gray-500 mt-2">
                {withLines.map(eq => `${eq.name} (${eq.devices?.length ?? 0})`).join(' · ')}
              </p>
            )}
            {records.length > 0 && (
              <div className="mt-3">
                <button
                  className="text-xs text-blue-600 hover:underline"
                  onClick={() => setShowPayload(v => !v)}
                >
                  {showPayload ? 'Hide' : 'Show'} the first record
                </button>
                {showPayload && (
                  <div className="relative mt-2">
                    <button
                      className="absolute right-2 top-2 p-1 bg-white/80 rounded hover:bg-white"
                      title="Copy the whole payload"
                      onClick={() => navigator.clipboard?.writeText(JSON.stringify(records, null, 2))}
                    >
                      <CopyIcon className="w-3.5 h-3.5 text-gray-500" />
                    </button>
                    <pre className="bg-gray-900 text-gray-100 text-[11px] leading-relaxed rounded p-3 max-h-64 overflow-auto">
                      {preview}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>

          {result && (
            <div className={`rounded-lg px-3 py-2 text-sm ${
              result.ok ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                        : 'bg-red-50 text-red-700 border border-red-200'
            }`}>
              {result.text}
            </div>
          )}
        </div>

        <div className="flex justify-between items-center gap-2 px-6 py-4 border-t bg-gray-50">
          <span className="text-xs text-gray-500">
            {records.length === 0
              ? 'Nothing to send — the switchgears have no feeder lines yet.'
              : `${records.length} record(s) via ${target ? target.url : 'the EPLAN bridge'}`}
          </span>
          <div className="flex gap-2">
            <button className="px-4 py-2 border rounded text-sm hover:bg-gray-100" onClick={onClose}>
              Close
            </button>
            <button
              className="px-4 py-2 bg-emerald-700 text-white rounded text-sm hover:bg-emerald-800 flex items-center gap-2 disabled:opacity-40"
              onClick={handleSend}
              disabled={!canSend}
            >
              <SendIcon className="w-4 h-4" />
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
