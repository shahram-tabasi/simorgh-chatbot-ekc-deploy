/**
 * ProposalsReviewDrawer — right-side slide-in panel that shows pending
 * extractor proposals grouped by field, lets the user edit, approve, or
 * reject each one. Replaces the inline proposals block that was crashing
 * the chat scroll surface; nothing here renders until the user clicks
 * the "X to review" pill on the Design Suite chip.
 *
 * Pure presentational: parent owns the data fetch and the approve/reject
 * RPC. The drawer just renders + fires callbacks.
 */
import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, Wand2, Check, Trash2, Pencil, Loader2,
  FileText, Database, MessagesSquare, GitBranch, Server, User as UserIcon,
} from "lucide-react";

export type Proposal = {
  id:           string;
  field:        string;
  value:        any;
  source_kind:  string;
  source_note?: string;
  confidence:   number;
};

interface Props {
  open:           boolean;
  onClose:        () => void;
  pendingByField: Record<string, Proposal[]>;
  approvedCount?: number;
  busyIds?:       Set<string>;
  onApprove:      (proposal: Proposal, editedValue?: string) => void | Promise<void>;
  onReject:       (proposal: Proposal) => void | Promise<void>;
}

const FIELD_LABELS: Record<string, string> = {
  projectName:           "Project name",
  projectDescription:    "Description",
  projectNumber:         "OE number",
  projectId:             "Project ID",
  client:                "Client",
  location:              "Location",
  standard:              "Standard",
  country:               "Country",
  language:              "Language",
  noticeToProceedDate:   "Notice-to-proceed date",
  deliveryDate:          "Delivery date",
  planner:               "Planner",
  designOffice:          "Design office",
  comment:               "Comment",
  equipments:            "Equipments / Panels",
  "techSettings.general":         "Tech settings · general",
  "techSettings.wireManufacturer":"Tech settings · wire manufacturer",
};

const SOURCE_META: Record<string, { label: string; icon: React.FC<{ className?: string }>; accent: string }> = {
  tpms:       { label: "TPMS",        icon: Database,       accent: "bg-sky-500/15 text-sky-200 border-sky-400/30" },
  uploads:    { label: "Uploads",     icon: FileText,       accent: "bg-violet-500/15 text-violet-200 border-violet-400/30" },
  chat:       { label: "Chat",        icon: MessagesSquare, accent: "bg-amber-500/15 text-amber-200 border-amber-400/30" },
  techserver: { label: "Tech server", icon: Server,         accent: "bg-emerald-500/15 text-emerald-200 border-emerald-400/30" },
  gitlab:     { label: "GitLab",      icon: GitBranch,      accent: "bg-orange-500/15 text-orange-200 border-orange-400/30" },
  user:       { label: "You",         icon: UserIcon,       accent: "bg-pink-500/15 text-pink-200 border-pink-400/30" },
  default:    { label: "Other",       icon: FileText,       accent: "bg-white/10 text-gray-200 border-white/20" },
};

function fmtValue(v: any): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  return String(v);
}

export default function ProposalsReviewDrawer({
  open, onClose, pendingByField, approvedCount = 0, busyIds, onApprove, onReject,
}: Props) {
  const fields = Object.keys(pendingByField).sort();
  const totalPending = fields.reduce(
    (n, f) => n + (pendingByField[f]?.length || 0), 0);
  const [edits, setEdits] = React.useState<Record<string, string>>({});

  // Reset edits whenever the drawer opens.
  React.useEffect(() => {
    if (!open) return;
    setEdits({});
  }, [open]);

  // Close on Escape.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            key="bd"
            className="fixed inset-0 z-[80] bg-black/40 backdrop-blur-sm"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
          />
          {/* Panel */}
          <motion.aside
            key="pn"
            className="fixed top-0 right-0 z-[81] h-full w-full sm:w-[460px] md:w-[520px]
                       bg-[#0f172a]/95 border-l border-white/10 backdrop-blur-xl
                       shadow-[0_0_40px_rgba(0,0,0,0.6)] flex flex-col"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 260 }}
            role="dialog"
            aria-label="Design Suite proposals to review"
          >
            {/* Header */}
            <div className="px-5 py-4 border-b border-white/10 flex items-start gap-3">
              <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500
                              flex items-center justify-center flex-shrink-0">
                <Wand2 className="w-4 h-4 text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-white font-semibold">Review extracted values</div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {totalPending === 0
                    ? approvedCount > 0
                      ? `${approvedCount} value${approvedCount === 1 ? "" : "s"} approved · nothing pending`
                      : "Nothing to review right now."
                    : `${totalPending} pending across ${fields.length} field${fields.length === 1 ? "" : "s"}`}
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {totalPending === 0 && (
                <div className="mt-10 text-center text-sm text-gray-400">
                  When the agent extracts new values from TPMS, uploads or chat,
                  they'll show up here for your approval.
                </div>
              )}

              {fields.map((field) => {
                const items = pendingByField[field] || [];
                if (items.length === 0) return null;
                return (
                  <div key={field}
                       className="rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden">
                    <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
                      <div className="text-sm text-gray-100 font-medium">
                        {FIELD_LABELS[field] || field}
                      </div>
                      <div className="text-[11px] text-gray-500 font-mono">{field}</div>
                    </div>
                    <div className="divide-y divide-white/[0.06]">
                      {items.map((prop) => (
                        <ProposalRow
                          key={prop.id}
                          prop={prop}
                          editValue={edits[prop.id]}
                          busy={!!busyIds?.has(prop.id)}
                          onEditChange={(val) => setEdits({ ...edits, [prop.id]: val })}
                          onApprove={(edited) => onApprove(prop, edited)}
                          onReject={() => onReject(prop)}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-white/10 text-[11px] text-gray-500">
              Approved values land in the project spec. Rejected ones are dropped.
              The agent will re-propose if new evidence comes in.
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function ProposalRow({
  prop, editValue, busy, onEditChange, onApprove, onReject,
}: {
  prop:         Proposal;
  editValue:    string | undefined;
  busy:         boolean;
  onEditChange: (v: string) => void;
  onApprove:    (editedValue?: string) => void;
  onReject:     () => void;
}) {
  const meta = SOURCE_META[prop.source_kind] || SOURCE_META.default;
  const SourceIcon = meta.icon;
  const original = fmtValue(prop.value);
  const current = editValue ?? original;
  const dirty = current !== original;
  const conf = Math.round((prop.confidence ?? 0) * 100);
  const confColor =
    conf >= 80 ? "text-emerald-300" : conf >= 50 ? "text-amber-300" : "text-rose-300";
  const multiline = current.includes("\n") || current.length > 60;

  return (
    <div className="p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] border ${meta.accent}`}>
          <SourceIcon className="w-3 h-3" />
          {meta.label}
        </span>
        <span className={`text-[11px] font-mono ${confColor}`}
              title="Extractor confidence">
          {conf}%
        </span>
        {dirty && (
          <span className="inline-flex items-center gap-1 text-[10px] text-indigo-200">
            <Pencil className="w-3 h-3" /> edited
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => onApprove(dirty ? current : undefined)}
          disabled={busy}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px]
                     bg-emerald-500/15 hover:bg-emerald-500/30 border border-emerald-400/40
                     text-emerald-100 transition-colors disabled:opacity-50"
          title={dirty ? "Save edit & approve" : "Approve"}
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          {dirty ? "Save & approve" : "Approve"}
        </button>
        <button
          onClick={onReject}
          disabled={busy}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px]
                     bg-rose-500/10 hover:bg-rose-500/25 border border-rose-400/30
                     text-rose-100 transition-colors disabled:opacity-50"
          title="Reject — value won't be saved"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Reject
        </button>
      </div>

      {multiline ? (
        <textarea
          value={current}
          onChange={(e) => onEditChange(e.target.value)}
          rows={Math.min(8, Math.max(2, current.split("\n").length + 1))}
          className="w-full px-3 py-2 bg-white/5 border border-white/10 focus:border-indigo-400/50
                     rounded-lg text-white text-sm font-mono leading-relaxed
                     outline-none transition-colors"
        />
      ) : (
        <input
          type="text"
          value={current}
          onChange={(e) => onEditChange(e.target.value)}
          className="w-full px-3 py-2 bg-white/5 border border-white/10 focus:border-indigo-400/50
                     rounded-lg text-white text-sm outline-none transition-colors"
        />
      )}

      {prop.source_note && (
        <div className="text-[11px] text-gray-500 line-clamp-2" title={prop.source_note}>
          {prop.source_note}
        </div>
      )}
    </div>
  );
}
