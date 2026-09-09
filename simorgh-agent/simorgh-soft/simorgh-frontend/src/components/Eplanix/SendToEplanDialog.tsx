import React, { useEffect, useMemo, useState } from 'react';
import { SendIcon, XIcon, PlugZapIcon, CheckCircle2Icon, AlertTriangleIcon, CopyIcon } from 'lucide-react';
import { ProjectData, Equipment, Revision } from '../../types/project';
import { buildEplanData, EplanData } from '../../utils/eplanDataExport';
import { eplanApi } from '../../services/eplanApi';

// "Send to EPLAN": the project's feeder lines as EplanData records, posted to
// the EPLAN drawing server.
//
// The address is one IP and one port. It comes from .env
// (VITE_EPLAN_API_HOST / VITE_EPLAN_API_PORT in the frontend, or
// EPLAN_API_HOST / EPLAN_API_PORT on the backend when those are left empty),
// and the two fields here start from it — so a one-off send to another
// machine does not need a rebuild. What goes over the wire is shown before
// it is sent: the record count, and the first record in full.

interface Props {
  projectData: ProjectData;
  equipments: Equipment[];
  currentRevision?: Revision | null;
  feedersPerPage: number;
  onClose: () => void;
}

const envHost = String(import.meta.env.VITE_EPLAN_API_HOST || '').trim();
const envPort = String(import.meta.env.VITE_EPLAN_API_PORT || '').trim();

export const SendToEplanDialog: React.FC<Props> = ({
  projectData, equipments, currentRevision, feedersPerPage, onClose,
}) => {
  const [host, setHost] = useState(envHost);
  const [port, setPort] = useState(envPort);
  const [source, setSource] = useState<'env' | 'server'>(envHost && envPort ? 'env' : 'server');
  const [probe, setProbe] = useState<{ state: 'idle' | 'testing' | 'up' | 'down'; note?: string }>({ state: 'idle' });
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [showPayload, setShowPayload] = useState(false);

  // Nothing set in the frontend .env? Then the backend's own address is the
  // one that will be used — show it rather than an empty pair of fields.
  useEffect(() => {
    if (envHost && envPort) return;
    let cancelled = false;
    eplanApi.getTarget()
      .then(target => {
        if (cancelled) return;
        setHost(h => h || target.host);
        setPort(p => p || String(target.port));
        setSource('server');
      })
      .catch(() => { /* the fields stay editable and empty */ });
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
  const portNumber = Number(port);
  const addressOk = !!host.trim() && Number.isFinite(portNumber) && portNumber > 0;
  const canSend = addressOk && records.length > 0 && !sending;

  const handleTest = async () => {
    setProbe({ state: 'testing' });
    setResult(null);
    try {
      const answer = await eplanApi.ping({ host: host.trim(), port: portNumber });
      setProbe(answer.reachable
        ? { state: 'up', note: `${answer.target} answered` }
        : { state: 'down', note: answer.error || `${answer.target} did not answer` });
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
        host: host.trim(),
        port: portNumber,
      });
      setResult(answer.success
        ? { ok: true, text: answer.message || `${records.length} record(s) sent.` }
        : { ok: false, text: answer.error || 'The EPLAN server did not accept the records.' });
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
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <label className="block text-xs text-gray-500 mb-1">IP address</label>
                <input
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-400"
                  value={host}
                  onChange={e => setHost(e.target.value)}
                  placeholder="192.168.1.39"
                />
              </div>
              <div className="w-28">
                <label className="block text-xs text-gray-500 mb-1">Port</label>
                <input
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-400"
                  value={port}
                  onChange={e => setPort(e.target.value.replace(/[^\d]/g, ''))}
                  placeholder="8000"
                />
              </div>
              <button
                className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 rounded text-sm hover:bg-gray-50 disabled:opacity-40"
                onClick={handleTest}
                disabled={!addressOk || probe.state === 'testing'}
              >
                <PlugZapIcon className="w-4 h-4" />
                {probe.state === 'testing' ? 'Testing…' : 'Test'}
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {source === 'env'
                ? 'From .env — VITE_EPLAN_API_HOST / VITE_EPLAN_API_PORT. Editing here changes this send only.'
                : 'From the server\'s .env — EPLAN_API_HOST / EPLAN_API_PORT. Editing here changes this send only.'}
            </p>
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
              : `POST http://${host || '…'}:${port || '…'} · ${records.length} record(s)`}
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
