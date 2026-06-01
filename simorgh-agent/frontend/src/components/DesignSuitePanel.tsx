/**
 * DesignSuitePanel — legacy-user feature surface for "create a Simorgh
 * Design Suite project from this chat".
 *
 * Calls the chatbot backend's two endpoints (gated by SOFT_BRIDGE_ENABLED
 * on the server):
 *   POST /api/v2/agent/projects/{projectId}/soft/gather
 *        → { spec, prov[], gaps[], conflicts[] }
 *        Run extractors over TPMS, chat history, uploaded docs; reconcile;
 *        return what we know with provenance + what's missing.
 *   POST /api/v2/agent/projects/{projectId}/soft/create  { spec }
 *        → { soft_project_id, deep_link }
 *        Validate, POST to simorgh-soft, return the deep-link URL.
 *
 * UX: a small "Create Design Suite Project" button (legacy users only)
 * opens a panel that shows every confirmable field with its source pill
 * ("from TPMS OE-04A12065"), highlights missing/conflicting fields, lets
 * the user edit, then redirects on submit. Modeled after the slot-filling
 * + human-in-the-loop confirmation pattern.
 */
import React from "react";
import axios from "axios";
import { Wand2, AlertCircle, CheckCircle2, ExternalLink, Loader } from "lucide-react";

const API_BASE = (import.meta as any).env?.VITE_API_BASE_URL || "/api";

type FieldProv = {
  field: string;
  value: any;
  source: "user" | "tpms" | "uploads" | "chat" | "gitlab" | "techserver" | "default";
  confidence: number;
  note?: string;
  conflict_with?: { value: any; source: string; confidence: number; note?: string } | null;
};
type GatherResponse = {
  spec: Record<string, any>;
  prov: FieldProv[];
  gaps: string[];
  conflicts: string[];
};

const FIELD_LABELS: Record<string, string> = {
  projectName: "Project name",
  projectDescription: "Description",
  projectNumber: "OE number",
  projectId: "Project ID (PID)",
  client: "Client",
  location: "Location",
  standard: "Standard",
  country: "Country",
  language: "Language",
  noticeToProceedDate: "NTP date",
  deliveryDate: "Delivery date",
  planner: "Planner",
  designOffice: "Design office",
  comment: "Comment",
};

const SOURCE_COLORS: Record<string, string> = {
  user:       "bg-emerald-500/20 text-emerald-200 border-emerald-500/40",
  tpms:       "bg-sky-500/20 text-sky-200 border-sky-500/40",
  uploads:    "bg-violet-500/20 text-violet-200 border-violet-500/40",
  chat:       "bg-amber-500/20 text-amber-100 border-amber-500/40",
  gitlab:     "bg-orange-500/20 text-orange-200 border-orange-500/40",
  techserver: "bg-blue-500/20 text-blue-200 border-blue-500/40",
  default:    "bg-white/10 text-gray-300 border-white/20",
};

interface Props {
  projectId: string;
  isLegacy: boolean;
}

export default function DesignSuitePanel({ projectId, isLegacy }: Props) {
  const [open, setOpen]     = React.useState(false);
  const [busy, setBusy]     = React.useState(false);
  const [error, setError]   = React.useState("");
  const [data, setData]     = React.useState<GatherResponse | null>(null);
  const [values, setValues] = React.useState<Record<string, any>>({});
  const [done, setDone]     = React.useState<{ deep_link: string } | null>(null);

  if (!isLegacy) return null;

  const token = () => localStorage.getItem("simorgh_token") || "";

  const startGather = async () => {
    setBusy(true); setError(""); setData(null); setDone(null);
    try {
      const r = await axios.post<GatherResponse>(
        `${API_BASE}/v2/agent/projects/${projectId}/soft/gather`,
        {}, { headers: { Authorization: `Bearer ${token()}` } },
      );
      setData(r.data);
      // Seed editable values from the proposed spec.
      const seed: Record<string, any> = { ...r.data.spec };
      setValues(seed);
      setOpen(true);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || "Failed to gather fields.");
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true); setError("");
    try {
      // Merge editable values back into the spec we send.
      const spec = { ...(data?.spec || {}), ...values };
      const r = await axios.post<{ soft_project_id: string; deep_link: string }>(
        `${API_BASE}/v2/agent/projects/${projectId}/soft/create`,
        { spec }, { headers: { Authorization: `Bearer ${token()}` } },
      );
      setDone({ deep_link: r.data.deep_link });
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || "Create failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="my-3">
      {!open && !done && (
        <button onClick={startGather} disabled={busy}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-indigo-600/30
                     hover:bg-indigo-600/50 border border-indigo-500/40 text-indigo-100
                     text-sm font-medium disabled:opacity-50">
          {busy ? <Loader className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
          Create Design Suite Project
        </button>
      )}

      {error && (
        <div className="mt-2 px-3 py-2 rounded bg-red-500/10 border border-red-500/30 text-red-200 text-sm flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5" /><span>{error}</span>
        </div>
      )}

      {open && data && !done && (
        <div className="mt-2 rounded-xl border border-white/10 bg-white/5 p-4">
          <h3 className="text-white font-semibold flex items-center gap-2">
            <Wand2 className="w-4 h-4" /> Confirm project parameters
          </h3>
          <p className="text-xs text-gray-400 mt-1">
            Filled from the project's enabled sources. Edit any field; missing or conflicting fields are highlighted.
          </p>

          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
            {Object.keys(FIELD_LABELS).map((field) => {
              const p = data.prov.find((x) => x.field === field);
              const isGap = data.gaps.includes(field);
              const isConflict = !!(p && p.conflict_with);
              const src = p?.source || "default";
              const note = p?.note || "";
              return (
                <label key={field} className={`block rounded-lg p-2 border ${
                  isGap ? "border-rose-500/50 bg-rose-500/5"
                  : isConflict ? "border-amber-500/50 bg-amber-500/5"
                  : "border-white/10"
                }`}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-gray-300">{FIELD_LABELS[field]}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] border ${SOURCE_COLORS[src]}`}
                          title={note}>
                      {src}{isGap ? " · missing" : ""}{isConflict ? " · conflict" : ""}
                    </span>
                  </div>
                  <input type="text"
                    value={(values[field] ?? "") as any}
                    onChange={(e) => setValues({ ...values, [field]: e.target.value })}
                    placeholder={isGap ? "Required — please provide" : ""}
                    className="w-full px-2 py-1.5 bg-white/10 border border-white/20 rounded text-white text-sm" />
                  {isConflict && p?.conflict_with && (
                    <div className="mt-1 text-[11px] text-amber-200">
                      also seen: <span className="font-mono">{String(p.conflict_with.value)}</span>
                      {" "}<span className="opacity-70">({p.conflict_with.source})</span>
                    </div>
                  )}
                </label>
              );
            })}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <button onClick={submit} disabled={busy || data.gaps.length > 0 && !values.projectName}
              className="px-3 py-2 rounded-lg bg-emerald-600/40 hover:bg-emerald-600/60
                         border border-emerald-500/40 text-emerald-100 text-sm font-medium
                         disabled:opacity-50 flex items-center gap-2">
              {busy ? <Loader className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              Create & open
            </button>
            <button onClick={() => setOpen(false)} disabled={busy}
              className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-gray-200 text-sm">
              Cancel
            </button>
            {data.conflicts.length > 0 && (
              <span className="text-xs text-amber-300">
                {data.conflicts.length} field(s) had conflicting sources — review the amber boxes.
              </span>
            )}
          </div>
        </div>
      )}

      {done && (
        <div className="mt-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 flex items-center justify-between gap-3">
          <span className="text-emerald-100 text-sm flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" /> Project created in Design Suite.
          </span>
          <a href={done.deep_link} target="_blank" rel="noreferrer"
             className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-emerald-600/40
                        hover:bg-emerald-600/60 border border-emerald-500/40 text-white text-sm">
            Open <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      )}
    </div>
  );
}
