/**
 * DesignSuiteInline — chat-side surface for the redesigned Design Suite
 * slot-collector flow.
 *
 * Two pieces in one tiny component (kept together so the user has ONE
 * status indicator for the whole flow):
 *
 *  1. A status chip showing the collector's completeness % + open-gaps
 *     count. Polled every 8s; click to refresh now. Lives at the top of
 *     the chat for legacy users when SOFT_BRIDGE_ENABLED.
 *
 *  2. Any open `ask_user` pending requests are rendered as an inline form
 *     under the chip. Submitting POSTs answers to /soft/answer/{pid};
 *     after a successful submit it auto-sends a brief chat message
 *     ("Provided the requested values: …") so the ReAct loop's next turn
 *     sees gaps=[] and proceeds to submit_soft_spec.
 *
 *  When submit_soft_spec succeeds the chip turns green and shows an
 *  "Open in Design Suite" button (deep-link).
 */
import React from "react";
import axios from "axios";
import { Wand2, Loader, CheckCircle2, ExternalLink, AlertCircle } from "lucide-react";

const API_BASE = (import.meta as any).env?.VITE_API_BASE_URL || "/api";

// Tailwind class per proposal source_kind. `default` is the fallback when an
// unknown kind shows up — never crash the render over a missing color.
const SOURCE_COLORS: Record<string, string> = {
  tpms:       "bg-sky-500/20 border-sky-400/40 text-sky-100",
  uploads:    "bg-violet-500/20 border-violet-400/40 text-violet-100",
  chat:       "bg-amber-500/20 border-amber-400/40 text-amber-100",
  techserver: "bg-emerald-500/20 border-emerald-400/40 text-emerald-100",
  gitlab:     "bg-orange-500/20 border-orange-400/40 text-orange-100",
  user:       "bg-pink-500/20 border-pink-400/40 text-pink-100",
  default:    "bg-white/10 border-white/20 text-gray-200",
};

type Question = {
  field:        string;
  header?:      string;
  question:     string;
  options?:     string[];
  multiSelect?: boolean;
};
type Pending = { id: string; questions: Question[]; created_at?: string };
type StateResp = {
  state: {
    completeness?:    number;
    gaps?:            string[];
    conflicts?:       string[];
    soft_project_id?: string;
    spec?:            any;
  };
  pending: Pending[];
};
type Proposal = {
  id:           string;
  field:        string;
  value:        any;
  source_kind:  string;
  source_note?: string;
  confidence:   number;
};
type ProposalsResp = {
  pending_by_field: Record<string, Proposal[]>;
  approved:         any[];
};

interface Props {
  projectId: string;
  isLegacy:  boolean;
  /** Called when the user resolves a pending form so the chat can auto-send
   *  a follow-up message back to the agent. */
  onAnswered?: (note: string) => void;
}

export default function DesignSuiteInline({ projectId, isLegacy, onAnswered }: Props) {
  const [state, setState]     = React.useState<StateResp | null>(null);
  const [proposals, setProposals] = React.useState<ProposalsResp | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError]     = React.useState("");
  // local form values per pending question id; keyed by `${pid}::${field}`.
  const [vals, setVals] = React.useState<Record<string, any>>({});
  // user-edited values for proposals; keyed by proposal_id.
  const [edits, setEdits] = React.useState<Record<string, string>>({});

  const token = () => localStorage.getItem("simorgh_token") || "";

  const fetchState = React.useCallback(async (refresh = false) => {
    if (!isLegacy || !projectId) return;
    setLoading(true); setError("");
    try {
      const [s, p] = await Promise.all([
        axios.get<StateResp>(
          `${API_BASE}/v2/agent/projects/${projectId}/soft/state` + (refresh ? "?refresh=true" : ""),
          { headers: { Authorization: `Bearer ${token()}` } },
        ),
        axios.get<ProposalsResp>(
          `${API_BASE}/v2/agent/projects/${projectId}/soft/proposals`,
          { headers: { Authorization: `Bearer ${token()}` } },
        ).catch(() => ({ data: { pending_by_field: {}, approved: [] } as ProposalsResp })),
      ]);
      setState(s.data);
      setProposals(p.data);
    } catch (e: any) {
      if (e?.response?.status === 404) { setState(null); return; }
      setError(e?.response?.data?.detail || e?.message || "");
    } finally {
      setLoading(false);
    }
  }, [projectId, isLegacy]);

  const decideProposal = async (proposal_id: string,
                                 action: "approve" | "reject" | "edit",
                                 value?: any) => {
    try {
      await axios.post(
        `${API_BASE}/v2/agent/projects/${projectId}/soft/approve`,
        { approvals: [{ proposal_id, action, value }] },
        { headers: { Authorization: `Bearer ${token()}` } },
      );
      await fetchState();
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || "Could not record decision.");
    }
  };

  React.useEffect(() => {
    fetchState();
    if (!isLegacy || !projectId) return;
    const t = setInterval(fetchState, 8000);
    return () => clearInterval(t);
  }, [fetchState, projectId, isLegacy]);

  if (!isLegacy || !state) return null;

  const pct       = Math.max(0, Math.min(100, state.state.completeness ?? 0));
  const gaps      = state.state.gaps || [];
  const submitted = !!state.state.soft_project_id;
  const pending   = state.pending || [];
  const pendingByField = proposals?.pending_by_field || {};
  const pendingFields  = Object.keys(pendingByField);
  const pendingCount   = pendingFields.reduce(
    (n, f) => n + (pendingByField[f]?.length || 0), 0);

  const submitAnswers = async (pid: string, questions: Question[]) => {
    const answers: Record<string, any> = {};
    for (const q of questions) {
      const v = vals[`${pid}::${q.field}`];
      if (v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0))
        answers[q.field] = v;
    }
    try {
      await axios.post(
        `${API_BASE}/v2/agent/projects/${projectId}/soft/answer/${pid}`,
        { answers },
        { headers: { Authorization: `Bearer ${token()}` } },
      );
      // Tell parent to send a chat message so the ReAct loop picks it up.
      const summary = Object.entries(answers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
        .join("; ");
      onAnswered?.(`I provided the requested values via the form (${summary}). Please continue creating the Design Suite project.`);
      // Refresh state to drop the resolved pending and bump completeness.
      await fetchState(true);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || "Could not save answers.");
    }
  };

  // Compact status chip.
  const chip = (
    <div className="flex items-center gap-2 text-xs">
      <Wand2 className="w-3.5 h-3.5 text-indigo-300" />
      <span className="text-gray-200">Design Suite spec:</span>
      <div className="relative w-28 h-1.5 bg-white/10 rounded">
        <div className={`absolute left-0 top-0 h-1.5 rounded transition-all ${
            submitted ? "bg-emerald-400" : pct >= 80 ? "bg-emerald-400/80"
              : pct >= 50 ? "bg-amber-400" : "bg-indigo-400"}`}
             style={{ width: `${pct}%` }} />
      </div>
      <span className="text-gray-300 font-medium">{pct}%</span>
      {gaps.length > 0 && !submitted && (
        <span className="text-amber-300/90">· {gaps.length} gap{gaps.length === 1 ? "" : "s"}</span>
      )}
      {submitted && (
        <a href={`/simorgh-design-suite/?projectId=${state.state.soft_project_id}`}
           target="_blank" rel="noreferrer"
           className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-100 border border-emerald-500/30">
          <CheckCircle2 className="w-3 h-3" /> Open <ExternalLink className="w-3 h-3" />
        </a>
      )}
      {loading && <Loader className="w-3 h-3 animate-spin text-gray-400" />}
    </div>
  );

  return (
    <div className="my-2 px-3 py-2 rounded-lg border border-white/10 bg-white/5">
      {chip}

      {error && (
        <div className="mt-2 text-xs text-red-200 flex items-center gap-1">
          <AlertCircle className="w-3 h-3" /> {error}
        </div>
      )}

      {/* Pending PROPOSALS — extractor output waiting for user review.
          One card per field; multiple competing sources stacked under it.
          User approves the value that's right, rejects the rest. NO
          autonomous write reaches the spec until this gate clears. */}
      {pendingCount > 0 && (
        <div className="mt-2 rounded-md border border-indigo-500/30 bg-indigo-500/5 p-2">
          <div className="text-xs text-indigo-100 mb-2">
            {pendingCount} extracted value{pendingCount === 1 ? "" : "s"} need your review
            <span className="opacity-70"> · approve the values that belong to THIS project, reject the rest.</span>
          </div>
          <div className="grid grid-cols-1 gap-2">
            {pendingFields.map((field) => (
              <div key={field} className="rounded border border-white/10 bg-white/5 p-2">
                <div className="text-xs text-gray-200 font-medium mb-1">
                  {field}
                </div>
                {(pendingByField[field] || []).map((prop) => {
                  const raw = prop?.value;
                  const asText = raw == null ? ""
                    : typeof raw === "object" ? JSON.stringify(raw) : String(raw);
                  const editVal = edits[prop.id] ?? asText;
                  const colorClass = SOURCE_COLORS[prop.source_kind] || SOURCE_COLORS.default;
                  return (
                    <div key={prop.id} className="flex flex-wrap items-center gap-2 py-1">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] border ${colorClass}`}
                            title={prop.source_note}>
                        {prop.source_kind}
                      </span>
                      <input type="text" value={editVal}
                        onChange={(e) => setEdits({ ...edits, [prop.id]: e.target.value })}
                        className="flex-1 min-w-[200px] px-2 py-1 bg-white/10 border border-white/20 rounded text-white text-xs" />
                      <span className="text-[10px] opacity-70">{Math.round((prop.confidence ?? 0) * 100)}%</span>
                      <button onClick={() => decideProposal(prop.id, edits[prop.id] !== undefined && edits[prop.id] !== asText ? "edit" : "approve", edits[prop.id])}
                        className="px-2 py-0.5 rounded text-[11px] bg-emerald-600/40 hover:bg-emerald-600/60 border border-emerald-500/40 text-emerald-100">
                        approve
                      </button>
                      <button onClick={() => decideProposal(prop.id, "reject")}
                        className="px-2 py-0.5 rounded text-[11px] bg-rose-600/30 hover:bg-rose-600/50 border border-rose-500/40 text-rose-100">
                        reject
                      </button>
                      {prop.source_note && (
                        <span className="text-[10px] text-gray-400 truncate max-w-[260px]" title={prop.source_note}>
                          {prop.source_note}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Inline ask_user forms (one per open pending request). */}
      {pending.map((p) => (
        <div key={p.id} className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
          <div className="text-xs text-amber-100 mb-1">
            The agent needs a few clarifications to finish your project:
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {(p.questions || []).map((q) => {
              const key = `${p.id}::${q.field}`;
              const v = vals[key];
              return (
                <label key={q.field} className="block text-xs">
                  <div className="text-gray-200 mb-0.5">
                    <span className="font-medium">{q.header || q.field}</span>
                    <span className="opacity-80"> — {q.question}</span>
                  </div>
                  {q.options && q.options.length > 0 ? (
                    q.multiSelect ? (
                      <div className="flex flex-wrap gap-1">
                        {q.options.map((opt) => {
                          const arr: string[] = Array.isArray(v) ? v : [];
                          const on = arr.includes(opt);
                          return (
                            <button key={opt} type="button"
                              onClick={() => setVals({
                                ...vals,
                                [key]: on ? arr.filter((x) => x !== opt) : [...arr, opt],
                              })}
                              className={`px-2 py-0.5 rounded border text-[11px] ${
                                on ? "bg-emerald-500/30 border-emerald-400 text-emerald-100"
                                   : "bg-white/5 border-white/20 text-gray-200"}`}>
                              {opt}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <select value={v ?? ""}
                        onChange={(e) => setVals({ ...vals, [key]: e.target.value })}
                        className="w-full bg-white/10 border border-white/20 rounded px-1.5 py-1 text-white">
                        <option value="">— pick —</option>
                        {q.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                      </select>
                    )
                  ) : (
                    <input type="text" value={v ?? ""}
                      onChange={(e) => setVals({ ...vals, [key]: e.target.value })}
                      className="w-full bg-white/10 border border-white/20 rounded px-1.5 py-1 text-white" />
                  )}
                </label>
              );
            })}
          </div>
          <div className="mt-2 flex justify-end">
            <button onClick={() => submitAnswers(p.id, p.questions)}
              className="px-2.5 py-1 rounded text-xs bg-emerald-600/40 hover:bg-emerald-600/60 border border-emerald-500/40 text-emerald-100">
              Submit answers
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
