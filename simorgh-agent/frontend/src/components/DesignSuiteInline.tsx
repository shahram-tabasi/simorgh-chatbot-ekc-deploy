/**
 * DesignSuiteInline — chat-side surface for the redesigned Design Suite
 * slot-collector flow.
 *
 *  - A compact status chip at the top of the chat (completeness %,
 *    optional gap count, optional "X to review" pill that opens the
 *    right-side <ProposalsReviewDrawer/>).
 *  - Any open `ask_user` pending requests are still rendered inline as a
 *    small form. Submitting POSTs answers to /soft/answer/{pid} and fires
 *    a follow-up chat message so the ReAct loop continues.
 *
 *  The big inline "review extracted values" block has moved into the
 *  side drawer (see ProposalsReviewDrawer.tsx). Approve / reject / edit
 *  emit toast events through the notifyBus so the user sees the
 *  status change without a chat reload.
 */
import React from "react";
import axios from "axios";
import { Wand2, Loader, CheckCircle2, ExternalLink, AlertCircle, Inbox } from "lucide-react";

import ProposalsReviewDrawer, { Proposal, CategoriesResp } from "./ProposalsReviewDrawer";
import { notify } from "../services/notifyBus";

const API_BASE = (import.meta as any).env?.VITE_API_BASE_URL || "/api";

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
  const [state, setState]         = React.useState<StateResp | null>(null);
  const [proposals, setProposals] = React.useState<ProposalsResp | null>(null);
  const [loading, setLoading]     = React.useState(false);
  const [error, setError]         = React.useState("");
  // local form values per pending question id; keyed by `${pid}::${field}`.
  const [vals, setVals]           = React.useState<Record<string, any>>({});
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [busyIds, setBusyIds]     = React.useState<Set<string>>(new Set());
  const [categories, setCategories] = React.useState<CategoriesResp | null>(null);
  // Track the previous pending count so we can fire a one-shot toast when
  // NEW proposals come in — we don't spam on every poll tick.
  const lastCountRef = React.useRef<number>(0);

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

  const decideProposal = async (prop: Proposal,
                                action: "approve" | "reject",
                                editedValue?: string) => {
    setBusyIds((prev) => { const n = new Set(prev); n.add(prop.id); return n; });
    try {
      await axios.post(
        `${API_BASE}/v2/agent/projects/${projectId}/soft/approve`,
        {
          approvals: [{
            proposal_id: prop.id,
            action: editedValue !== undefined ? "edit" : action,
            value: editedValue,
          }],
        },
        { headers: { Authorization: `Bearer ${token()}` } },
      );
      notify({
        type: action === "approve" ? "success" : "info",
        title: action === "approve" ? "Approved" : "Rejected",
        message: `${prop.field} · ${prop.source_kind}`,
      });
      await fetchState();
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || "Could not record decision.";
      setError(msg);
      notify({ type: "error", title: "Decision failed", message: msg });
    } finally {
      setBusyIds((prev) => { const n = new Set(prev); n.delete(prop.id); return n; });
    }
  };

  // Wrappers for the drawer's callback shape.
  const onApprove = (prop: Proposal, editedValue?: string) =>
    decideProposal(prop, "approve", editedValue);
  const onReject  = (prop: Proposal) =>
    decideProposal(prop, "reject");

  // Create the Design Suite project from the currently-approved spec
  // and open it in a new tab. Called by the "Create Design Suite
  // Project" button in the drawer footer. Backend route does the
  // docker-style tagging + POST to simorgh-soft and returns a deep
  // link. We mirror the agent's submit_soft_spec path so both UIs
  // produce identical project records.
  const [creating, setCreating] = React.useState(false);
  const onCreate = async () => {
    const spec = state?.spec || {};
    if (!Object.keys(spec).length) {
      notify({ type: "error", title: "Nothing to create",
        message: "No approved values yet. Approve at least one proposal first." });
      return;
    }
    setCreating(true);
    try {
      const r = await axios.post(
        `${API_BASE}/v2/agent/projects/${projectId}/soft/create`,
        { spec },
        { headers: { Authorization: `Bearer ${token()}` } },
      );
      const link = r?.data?.deep_link || "";
      const sid  = r?.data?.soft_project_id || "";
      notify({
        type: "success",
        title: "Design Suite project created",
        message: sid ? `Opening project ${sid}…` : "Opening Design Suite…",
      });
      if (link) window.open(link, "_blank", "noopener,noreferrer");
      onAnswered?.(
        `Design Suite project created (id ${sid}). Deep link: ${link}`,
      );
      await fetchState();
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message ||
                  "Could not create Design Suite project.";
      setError(msg);
      notify({ type: "error", title: "Create failed", message: msg });
    } finally {
      setCreating(false);
    }
  };

  React.useEffect(() => {
    fetchState();
    if (!isLegacy || !projectId) return;
    const t = setInterval(fetchState, 8000);
    return () => clearInterval(t);
  }, [fetchState, projectId, isLegacy]);

  // Fetch the category taxonomy once per session — the list is global
  // (not project-scoped) and very stable, so the polling above doesn't
  // need to refetch it. Drawer falls back to a flat layout if this
  // request fails.
  React.useEffect(() => {
    if (!isLegacy) return;
    let cancelled = false;
    axios.get<CategoriesResp>(`${API_BASE}/v2/agent/soft/categories`)
      .then((r) => { if (!cancelled) setCategories(r.data); })
      .catch(() => { /* drawer renders flat if categories unavailable */ });
    return () => { cancelled = true; };
  }, [isLegacy]);

  // Compute these always (hooks-before-return rule).
  const pendingByField = proposals?.pending_by_field || {};
  const pendingFields  = Object.keys(pendingByField);
  const pendingCount   = pendingFields.reduce(
    (n, f) => n + (pendingByField[f]?.length || 0), 0);
  const approvedCount  = proposals?.approved?.length || 0;

  // Toast on transition 0 → >0 (or every time the count goes up). Stays
  // muted while the user is already reviewing (drawer open).
  React.useEffect(() => {
    if (drawerOpen) { lastCountRef.current = pendingCount; return; }
    if (pendingCount > lastCountRef.current) {
      const delta = pendingCount - lastCountRef.current;
      notify({
        type: "info",
        title: "New values to review",
        message: `${delta} extracted value${delta === 1 ? "" : "s"} need your approval — open the review panel to decide.`,
      });
    }
    lastCountRef.current = pendingCount;
  }, [pendingCount, drawerOpen]);

  if (!isLegacy || !state) return null;

  const pct       = Math.max(0, Math.min(100, state.state.completeness ?? 0));
  const gaps      = state.state.gaps || [];
  const submitted = !!state.state.soft_project_id;
  const pending   = state.pending || [];

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
      const summary = Object.entries(answers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
        .join("; ");
      onAnswered?.(`I provided the requested values via the form (${summary}). Please continue creating the Design Suite project.`);
      await fetchState(true);
      notify({ type: "success", title: "Answers saved", message: summary });
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || "Could not save answers.";
      setError(msg);
      notify({ type: "error", title: "Could not save answers", message: msg });
    }
  };

  // Compact status chip — single horizontal row, no surrounding card.
  return (
    <div className="my-2 flex items-center flex-wrap gap-x-3 gap-y-1 text-xs">
      <span className="inline-flex items-center gap-1.5 text-gray-300">
        <Wand2 className="w-3.5 h-3.5 text-indigo-300" />
        Design Suite
      </span>

      <div className="relative w-28 h-1.5 bg-white/10 rounded">
        <div className={`absolute left-0 top-0 h-1.5 rounded transition-all ${
            submitted ? "bg-emerald-400" : pct >= 80 ? "bg-emerald-400/80"
              : pct >= 50 ? "bg-amber-400" : "bg-indigo-400"}`}
             style={{ width: `${pct}%` }} />
      </div>
      <span className="text-gray-300 font-medium tabular-nums">{pct}%</span>

      {gaps.length > 0 && !submitted && (
        <span className="text-amber-300/90">
          {gaps.length} gap{gaps.length === 1 ? "" : "s"}
        </span>
      )}

      {pendingCount > 0 && (
        <button
          onClick={() => setDrawerOpen(true)}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full
                     bg-indigo-500/15 hover:bg-indigo-500/30 border border-indigo-400/40
                     text-indigo-100 transition-colors"
          title="Review extracted values"
        >
          <Inbox className="w-3 h-3" />
          {pendingCount} to review
        </button>
      )}

      {submitted && (
        <a href={`/simorgh-design-suite/?projectId=${state.state.soft_project_id}`}
           target="_blank" rel="noreferrer"
           className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-100 border border-emerald-500/30">
          <CheckCircle2 className="w-3 h-3" /> Open <ExternalLink className="w-3 h-3" />
        </a>
      )}

      {loading && <Loader className="w-3 h-3 animate-spin text-gray-400" />}

      {error && (
        <span className="inline-flex items-center gap-1 text-red-300">
          <AlertCircle className="w-3 h-3" /> {error}
        </span>
      )}

      {/* Inline ask_user forms (one per open pending request). */}
      {pending.length > 0 && (
        <div className="basis-full mt-1 w-full space-y-2">
          {pending.map((p) => (
            <div key={p.id} className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
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
      )}

      {/* Right-side proposal review drawer. */}
      <ProposalsReviewDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        pendingByField={pendingByField}
        approvedCount={approvedCount}
        busyIds={busyIds}
        categories={categories}
        onApprove={onApprove}
        onReject={onReject}
        onCreate={onCreate}
        creating={creating}
        canCreate={approvedCount > 0}
      />
    </div>
  );
}
