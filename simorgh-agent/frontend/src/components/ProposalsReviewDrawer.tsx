/**
 * ProposalsReviewDrawer — right-side slide-in panel that shows pending
 * extractor proposals grouped by field, lets the user edit, approve, or
 * reject each one.
 *
 * Audience-aware presentation
 * ---------------------------
 * Legacy users are electrical engineers, not programmers. So a value
 * like `equipments` (an array of panel objects from TPMS) must render
 * as "11 panels · 268 feeders · 2500 A max switch amperage" with an
 * expandable per-panel card showing IP class, busbar size, fault
 * current — NOT as a JSON dump. A value like `techSettings.general`
 * renders as a labelled key-value table with engineering units
 * (50 °C, 1800 m a.s.l.), not as `{"designTemperature":"50",...}`.
 *
 * Per-field renderers live in renderers/* below and are dispatched by
 * field name. Unknown fields fall back to plain text / JSON.
 *
 * The data contract is unchanged — backend still posts:
 *   { id, field, value, source_kind, source_note?, confidence }
 * The drawer parses `source_note` for the evidence-span pull-quote
 * the Phase 2 whole-doc extractor bakes in
 * ("from spec 'X.pdf' · § Site Conditions · \"design ambient: 50 °C\"").
 */
import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, Wand2, Check, Trash2, Pencil, Loader2, ChevronDown,
  FileText, Database, MessagesSquare, GitBranch, Server, User as UserIcon,
  Quote, Zap, Thermometer, Mountain, Activity, ShieldCheck,
  Gauge, Cable, CircuitBoard,
} from "lucide-react";

export type Proposal = {
  id:           string;
  field:        string;
  value:        any;
  source_kind:  string;
  source_note?: string;
  confidence:   number;
};

// Backend-provided category taxonomy (Phase C). Fetched once per
// session from GET /soft/categories — the drawer renders one
// collapsible section per group. If null/undefined, the drawer falls
// back to a flat field-by-field layout (legacy behaviour).
export type CategoryGroup = {
  id:     string;
  label:  string;
  hint?:  string;
  fields: string[];
};
export type CategoriesResp = {
  groups:            CategoryGroup[];
  field_to_category: Record<string, string>;
  fallback:          string;
};

interface Props {
  open:           boolean;
  onClose:        () => void;
  pendingByField: Record<string, Proposal[]>;
  approvedCount?: number;
  busyIds?:       Set<string>;
  /** Category taxonomy from GET /soft/categories. Null = flat fallback. */
  categories?:    CategoriesResp | null;
  onApprove:      (proposal: Proposal, editedValue?: string) => void | Promise<void>;
  onReject:       (proposal: Proposal) => void | Promise<void>;
  /** Push the approved spec to simorgh-soft. The drawer renders a
   *  primary footer button that calls this; disabled while creating
   *  or when no approvals exist yet. */
  onCreate?:      () => void | Promise<void>;
  creating?:      boolean;
  canCreate?:     boolean;
}

// ---------------------------------------------------------------------------
// Field metadata — labels, hints, units, icons. Tuned for the engineering
// audience: a planner / design engineer should read these without scrolling
// back to a docs page.
// ---------------------------------------------------------------------------
type FieldMeta = {
  label:   string;
  hint?:   string;
  unit?:   string;
  icon?:   React.FC<{ className?: string }>;
};

const FIELD_META: Record<string, FieldMeta> = {
  projectName:           { label: "Project name" },
  projectDescription:    { label: "Description / scope" },
  projectNumber:         { label: "OE number", hint: "TPMS project code" },
  projectId:             { label: "Project ID (PID)", hint: "Often equal to the OE number" },
  client:                { label: "Client", hint: "End customer / owner" },
  location:              { label: "Site location" },
  standard:              { label: "Primary standard", hint: "IEC / IEEE / ANSI family" },
  country:               { label: "Country of installation" },
  language:              { label: "Document language" },
  noticeToProceedDate:   { label: "Notice-to-proceed date" },
  deliveryDate:          { label: "Delivery / completion date" },
  planner:               { label: "Planner / responsible engineer" },
  designOffice:          { label: "Design office / EPC" },
  comment:               { label: "Free-form note" },
  equipments:            { label: "Equipment & panels",
                           hint: "Switchgear panels with their feeders, from TPMS",
                           icon: CircuitBoard },
  "techSettings.general":
    { label: "Site & ratings (general)", icon: Zap,
      hint: "Voltage, frequency, fault current, design conditions" },
  "techSettings.wireManufacturer":
    { label: "Wire / cable manufacturer", icon: Cable },
  // Nested keys produced by the whole-doc extractor:
  "techSettings.general.designTemperature":
    { label: "Design ambient temperature", unit: "°C", icon: Thermometer },
  "techSettings.general.altitudeAboveSeaLevel":
    { label: "Altitude above sea level", unit: "m a.s.l.", icon: Mountain },
  "techSettings.general.nominalVoltage":
    { label: "Nominal voltage (MV system)", unit: "kV", icon: Zap },
  "techSettings.general.ratedFrequency":
    { label: "Rated frequency", unit: "Hz", icon: Activity },
  "techSettings.general.shortCircuitCurrent":
    { label: "Short-circuit current (Icw)", unit: "kA", icon: Activity,
      hint: "Short-time withstand current, typically for 1–3 s" },
  "techSettings.general.bil":
    { label: "Basic insulation level (BIL)", unit: "kV", icon: ShieldCheck,
      hint: "1.2/50 µs impulse withstand voltage" },
  "techSettings.general.ipRating":
    { label: "IP / IK class", icon: ShieldCheck },
  "techSettings.general.iacClass":
    { label: "Internal arc class (IAC)", icon: ShieldCheck,
      hint: "Per IEC 62271-200 — e.g. IAC AFLR 40 kA 1 s" },
  "techSettings.general.controlVoltage":
    { label: "Control / auxiliary voltage", icon: Gauge },
  "techSettings.wireManufacturer.mv":
    { label: "MV wire / cable maker(s)", icon: Cable },
  "techSettings.wireManufacturer.lv":
    { label: "LV wire / cable maker(s)", icon: Cable },

  // ── Phase C — alt nesting (technicalSettings.*) ───────────────────
  "technicalSettings.mediumVoltage.nominalVoltage":
    { label: "MV nominal voltage", unit: "kV", icon: Zap },
  "technicalSettings.mediumVoltage.maxShortCircuitPower":
    { label: "MV max short-circuit power", unit: "MVA", icon: Activity },
  "technicalSettings.mediumVoltage.minShortCircuitPower":
    { label: "MV min short-circuit power", unit: "MVA", icon: Activity },
  "technicalSettings.lowVoltage.nominalVoltage":
    { label: "LV nominal voltage", unit: "V", icon: Zap },
  "technicalSettings.lowVoltage.frequency":
    { label: "LV frequency", unit: "Hz", icon: Activity },
  "technicalSettings.lowVoltage.permissibleTouchVoltage":
    { label: "Permissible touch voltage", unit: "V", icon: ShieldCheck,
      hint: "IEC 61936 — typical 50 V AC / 120 V DC for short fault clearance" },
  "technicalSettings.lowVoltage.ambientTemperature":
    { label: "LV ambient temperature", unit: "°C", icon: Thermometer },
  "technicalSettings.lowVoltage.numberOfPoles":
    { label: "Number of poles", icon: Cable, hint: "3 (3W) or 4 (3W+N)" },
  "technicalSettings.lowVoltage.earthFaultDetection":
    { label: "Earth-fault detection method", icon: ShieldCheck },

  // ── Phase C — wire size (cross-section, mm²) ──────────────────────
  "techSettings.wireSize.controlCircuit":
    { label: "Control circuit", unit: "mm²", icon: Cable },
  "techSettings.wireSize.ctSecondary":
    { label: "CT secondary", unit: "mm²", icon: Cable },
  "techSettings.wireSize.ptSecondary":
    { label: "PT / VT secondary", unit: "mm²", icon: Cable },
  "techSettings.wireSize.plcPowerSupply":
    { label: "PLC power supply", unit: "mm²", icon: Cable },

  // ── Phase C — wire colour (per IEC 60446) ─────────────────────────
  "techSettings.wireColor.acPhase":
    { label: "AC phase colour", icon: Cable,
      hint: "IEC 60446: L1 brown / L2 black / L3 grey" },
  "techSettings.wireColor.acNeutral":
    { label: "AC neutral colour", icon: Cable, hint: "IEC default: blue" },
  "techSettings.wireColor.dcPlus":
    { label: "DC + colour", icon: Cable },
  "techSettings.wireColor.dcMinus":
    { label: "DC − colour", icon: Cable },
  "techSettings.wireColor.plcInput":
    { label: "PLC input colour", icon: Cable },
  "techSettings.wireColor.plcOutput":
    { label: "PLC output colour", icon: Cable },
  "techSettings.wireColor.threePhase":
    { label: "Three-phase code system", icon: Cable },

  // ── Phase C — finishes / labelling ────────────────────────────────
  "techSettings.others.thicknessOfPainting":
    { label: "Paint coat thickness", unit: "µm", icon: ShieldCheck,
      hint: "Typical 60–100 µm dry-film thickness" },
  "techSettings.others.colorType":
    { label: "Paint colour standard", icon: ShieldCheck,
      hint: "IEC default: RAL 7032 light grey" },
  "techSettings.others.backgroundColor":
    { label: "Label background colour", icon: ShieldCheck },
  "techSettings.others.writingColor":
    { label: "Label engraving / writing colour", icon: ShieldCheck },
};

function fieldMeta(field: string): FieldMeta {
  return FIELD_META[field] || { label: field };
}

// ---------------------------------------------------------------------------
// Source-pill styling — same intent as the previous version, but with
// friendlier labels for the engineering audience.
// ---------------------------------------------------------------------------
const SOURCE_META: Record<string, { label: string; icon: React.FC<{ className?: string }>; accent: string; tip: string }> = {
  tpms:       { label: "TPMS",                icon: Database,       accent: "bg-sky-500/15 text-sky-200 border-sky-400/30",
                tip:    "Direct from TPMS database — typed columns, high confidence" },
  uploads:    { label: "Spec document",       icon: FileText,       accent: "bg-violet-500/15 text-violet-200 border-violet-400/30",
                tip:    "Extracted from an uploaded specification / datasheet" },
  chat:       { label: "From chat",           icon: MessagesSquare, accent: "bg-amber-500/15 text-amber-200 border-amber-400/30",
                tip:    "Pulled from earlier conversation with the agent" },
  techserver: { label: "Tech server",         icon: Server,         accent: "bg-emerald-500/15 text-emerald-200 border-emerald-400/30",
                tip:    "From the project's TechServer working folder" },
  gitlab:     { label: "GitLab",              icon: GitBranch,      accent: "bg-orange-500/15 text-orange-200 border-orange-400/30",
                tip:    "From the project's GitLab repository" },
  user:       { label: "Provided by you",     icon: UserIcon,       accent: "bg-pink-500/15 text-pink-200 border-pink-400/30",
                tip:    "Value you supplied via the chat / forms" },
  default:    { label: "Other",               icon: FileText,       accent: "bg-white/10 text-gray-200 border-white/20",
                tip:    "" },
};

// ---------------------------------------------------------------------------
// Source-note parser — the Phase 2 whole-doc extractor formats the note as
//   "from spec 'X.pdf' · § Section · \"verbatim quote from doc\""
// Surface the pieces separately so we can render the quote as a pull-quote
// and the section as a small chip.
// ---------------------------------------------------------------------------
interface SourceNoteParts {
  filename?: string;
  section?:  string;
  evidence?: string;
  raw:       string;
}

function parseSourceNote(note?: string): SourceNoteParts {
  const raw = (note || "").trim();
  if (!raw) return { raw: "" };
  const parts: SourceNoteParts = { raw };
  // Filename — "from spec 'X.pdf'" / "from datasheet 'Y.pdf'" etc.
  const fnMatch = raw.match(/from\s+\w+\s+['"]([^'"]+)['"]/i);
  if (fnMatch) parts.filename = fnMatch[1];
  // Section — "§ Section heading"
  const secMatch = raw.match(/§\s*([^·\n]+?)(?:\s*·|$)/);
  if (secMatch) parts.section = secMatch[1].trim();
  // Evidence — a quoted "..." run anywhere in the note. Prefer the last
  // (the whole-doc extractor puts it at the end).
  const quoteMatches = [...raw.matchAll(/[“"](.+?)[”"]/g)];
  if (quoteMatches.length > 0) {
    parts.evidence = quoteMatches[quoteMatches.length - 1][1];
  }
  return parts;
}

// ===========================================================================
// VALUE RENDERERS — dispatch by field name. Returns the value cell + the
// optional "edit affordance" the row can place inline. Complex values
// (panel arrays, settings objects) come back READ-ONLY since user-side
// editing of those is fragile — the user approves/rejects whole records.
// ===========================================================================
type RenderResult = {
  display:     React.ReactNode;        // the rendered value
  editable?:   "text" | "longtext" | "date" | null;  // type of inline edit, if any
  initialText?: string;                 // initial text for the edit input
  approveValue?: string | undefined;    // value to POST on approve when not edited
};

function renderValue(field: string, value: any): RenderResult {
  if (value == null) {
    return { display: <span className="text-gray-500 italic">empty</span> };
  }

  // ---- Complex objects/arrays: dispatch to dedicated renderers ------------
  if (field === "equipments" && Array.isArray(value)) {
    return { display: <EquipmentsSummary equipments={value} /> };
  }
  if (field === "techSettings.general" && typeof value === "object" && !Array.isArray(value)) {
    return { display: <TechSettingsTable settings={value} /> };
  }
  if (field === "techSettings.wireManufacturer" && typeof value === "object") {
    return { display: <WireManufacturerView value={value} /> };
  }
  if (typeof value === "object") {
    // Generic object fallback — key-value rows (no raw JSON).
    return { display: <GenericKeyValueView value={value} /> };
  }

  // ---- Primitives: text editable -----------------------------------------
  const text = String(value);

  // Date-like
  if (field.toLowerCase().includes("date") && /^\d{4}-\d{2}-\d{2}/.test(text)) {
    return {
      display: <span className="font-mono text-gray-100">{text.slice(0, 10)}</span>,
      editable: "date", initialText: text.slice(0, 10),
    };
  }

  // Show units for known numeric fields
  const meta = fieldMeta(field);
  if (meta.unit && /[\d.]/.test(text)) {
    return {
      display: (
        <span className="text-gray-100">
          <span className="font-medium">{text}</span>
          <span className="ml-1 text-xs text-gray-400">{meta.unit}</span>
        </span>
      ),
      editable: "text", initialText: text,
    };
  }

  // Long free text → textarea
  const isLong = text.length > 80 || text.includes("\n");
  return {
    display: <span className="text-gray-100 whitespace-pre-wrap">{text}</span>,
    editable: isLong ? "longtext" : "text",
    initialText: text,
  };
}

// ---------------------------------------------------------------------------
// EquipmentsSummary — top-level stats then collapsible per-panel cards.
// Read-only: TPMS data isn't hand-edited in the UI, only approved/rejected.
// ---------------------------------------------------------------------------
function EquipmentsSummary({ equipments }: { equipments: any[] }) {
  const [expanded, setExpanded] = React.useState(false);
  const panels = equipments.length;
  const feeders = equipments.reduce(
    (n, e) => n + (Array.isArray(e?.devices) ? e.devices.length : 0), 0);
  const maxA = equipments.reduce((max, e) => {
    const raw = (e?.properties?.switchAmperage || e?.power || "").toString();
    const m = raw.match(/(\d+)/);
    return m ? Math.max(max, parseInt(m[1], 10)) : max;
  }, 0);
  const types = Array.from(new Set(equipments.map((e) => e?.type).filter(Boolean)));

  return (
    <div className="space-y-2">
      {/* Headline stats */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Stat label="Panels"  value={panels}  />
        <Stat label="Feeders" value={feeders} />
        {maxA > 0 && <Stat label="Max switch amperage" value={`${maxA} A`} />}
        {types.length > 0 && <Stat label="Types" value={types.join(" / ")} />}
      </div>

      {/* Show/hide details */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="text-xs text-indigo-300 hover:text-indigo-200 inline-flex items-center gap-1"
      >
        <ChevronDown className={`w-3 h-3 transition-transform ${expanded ? "rotate-180" : ""}`} />
        {expanded ? "Hide" : "Show"} per-panel details
      </button>

      {expanded && (
        <div className="grid grid-cols-1 gap-1.5 mt-1">
          {equipments.map((e, i) => (
            <PanelCard key={e?.id || i} panel={e} />
          ))}
        </div>
      )}
    </div>
  );
}

function PanelCard({ panel }: { panel: any }) {
  const p = panel?.properties || {};
  const rows: Array<[string, string]> = [
    ["Type",           panel?.type || "—"],
    ["Description",    panel?.description || "—"],
    ["Switch amperage", p.switchAmperage || panel?.power || "—"],
    ["Rated voltage",  p.ratedVoltage  ? `${p.ratedVoltage} V` : "—"],
    ["Short-circuit (kabus)", p.kabus || "—"],
    ["IP",             p.ip != null ? String(p.ip) : "—"],
    ["Main busbar",    p.mainBusbarSize || "—"],
    ["Earth busbar",   p.earthBusbarSize || "—"],
    ["Feeders",        Array.isArray(panel?.devices) ? String(panel.devices.length) : "0"],
  ];
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
      <div className="flex items-center justify-between mb-1">
        <div className="text-xs text-white font-medium">
          {panel?.name || panel?.id || "Panel"}
        </div>
        {panel?.type && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-200 border border-indigo-400/30">
            {panel.type}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
        {rows
          .filter(([, v]) => v && v !== "—")
          .map(([k, v]) => (
            <React.Fragment key={k}>
              <span className="text-gray-400">{k}</span>
              <span className="text-gray-100 truncate">{v}</span>
            </React.Fragment>
          ))}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="inline-flex items-baseline gap-1">
      <span className="text-gray-400 text-xs">{label}</span>
      <span className="text-white font-medium tabular-nums">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TechSettingsTable — render techSettings.general as a labelled, unit-aware
// grid (designTemperature → "Design ambient temperature 50 °C").
// ---------------------------------------------------------------------------
function TechSettingsTable({ settings }: { settings: Record<string, any> }) {
  const keys = Object.keys(settings || {});
  if (keys.length === 0) {
    return <span className="text-gray-500 italic">empty</span>;
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1 text-xs">
      {keys.map((k) => {
        const m = fieldMeta(`techSettings.general.${k}`);
        const val = settings[k];
        if (val == null || val === "") return null;
        const Icon = m.icon;
        return (
          <div key={k} className="flex items-baseline gap-2">
            {Icon && <Icon className="w-3 h-3 text-gray-500 flex-shrink-0" />}
            <span className="text-gray-400 flex-shrink-0">{m.label || k}</span>
            <span className="text-gray-100 font-medium ml-auto">
              {String(val)}
              {m.unit && <span className="ml-0.5 text-gray-400">{m.unit}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function WireManufacturerView({ value }: { value: Record<string, any> }) {
  const keys = Object.keys(value || {});
  if (keys.length === 0) {
    return <span className="text-gray-500 italic">empty</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {keys.map((k) => {
        const v = value[k];
        if (!v) return null;
        return (
          <span key={k} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md
                                   bg-violet-500/15 text-violet-100 border border-violet-400/30 text-xs">
            <span className="text-violet-300 uppercase text-[10px]">{k}</span>
            <span className="text-white">{String(v)}</span>
          </span>
        );
      })}
    </div>
  );
}

function GenericKeyValueView({ value }: { value: Record<string, any> }) {
  const entries = Object.entries(value || {}).filter(([, v]) => v != null && v !== "");
  if (entries.length === 0) {
    return <span className="text-gray-500 italic">empty</span>;
  }
  return (
    <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
      {entries.map(([k, v]) => (
        <React.Fragment key={k}>
          <span className="text-gray-400 font-mono">{k}</span>
          <span className="text-gray-100 truncate">
            {typeof v === "object" ? JSON.stringify(v) : String(v)}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

// ===========================================================================
// Drawer
// ===========================================================================
export default function ProposalsReviewDrawer({
  open, onClose, pendingByField, approvedCount = 0, busyIds,
  categories, onApprove, onReject,
  onCreate, creating = false, canCreate = false,
}: Props) {
  const fields = Object.keys(pendingByField).sort();
  const totalPending = fields.reduce(
    (n, f) => n + (pendingByField[f]?.length || 0), 0);
  const [edits, setEdits] = React.useState<Record<string, string>>({});

  // ── Category bucketing ─────────────────────────────────────────────
  // Group pending fields into the IEC/SIMARIS-aligned sections served
  // by GET /soft/categories. The drawer renders one collapsible section
  // per group, in the canonical order. Anything the backend hasn't
  // categorised (or new fields the frontend doesn't know about yet)
  // lands in the trailing 'other' bucket.
  const bucketed = React.useMemo(() => {
    if (!categories?.groups?.length) return null;
    const map = categories.field_to_category || {};
    const fallback = categories.fallback || "other";
    const buckets: Record<string, string[]> = {};
    for (const group of categories.groups) buckets[group.id] = [];
    buckets[fallback] = [];
    for (const f of fields) {
      if (!pendingByField[f]?.length) continue;
      const cat = map[f] || fallback;
      (buckets[cat] = buckets[cat] || []).push(f);
    }
    return buckets;
  }, [fields, pendingByField, categories]);

  // Per-section expanded state. Default: expanded if it has pending
  // proposals, collapsed otherwise. The user can manually toggle to
  // see what categories exist even when empty.
  const [expandedSections, setExpandedSections] = React.useState<Record<string, boolean>>({});
  const toggleSection = (id: string) =>
    setExpandedSections((p) => ({ ...p, [id]: !((p[id] ?? null) === null
      ? (bucketed?.[id]?.length ?? 0) > 0
      : p[id]) }));
  const isExpanded = (id: string): boolean =>
    expandedSections[id] ?? ((bucketed?.[id]?.length ?? 0) > 0);

  React.useEffect(() => { if (open) setEdits({}); }, [open]);
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
          <motion.div
            key="bd"
            className="fixed inset-0 z-[80] bg-black/40 backdrop-blur-sm"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            key="pn"
            className="fixed top-0 right-0 z-[81] h-full w-full sm:w-[520px] md:w-[600px] lg:w-[680px]
                       bg-[#0f172a]/95 border-l border-white/10 backdrop-blur-xl
                       shadow-[0_0_40px_rgba(0,0,0,0.6)] flex flex-col"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 260 }}
            role="dialog"
            aria-label="Design Suite proposals to review"
          >
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

            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {totalPending === 0 && (
                <div className="mt-10 text-center text-sm text-gray-400 max-w-sm mx-auto">
                  As the agent extracts values from your spec PDFs, TPMS, or
                  chat, they'll appear here — each one with its source and
                  evidence — for you to approve before it's saved to the
                  project.
                </div>
              )}

              {/* Category-grouped layout (preferred) — falls back to the
                  flat per-field cards below when /soft/categories was
                  unreachable at app load. */}
              {bucketed && categories && categories.groups.map((group) => {
                const groupFields = bucketed[group.id] || [];
                const groupPendingCount = groupFields.reduce(
                  (n, f) => n + (pendingByField[f]?.length || 0), 0);
                if (groupPendingCount === 0) return null; // hide empty cats
                const open = isExpanded(group.id);
                return (
                  <div key={group.id}
                       className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
                    {/* Category header — click to collapse/expand */}
                    <button
                      onClick={() => toggleSection(group.id)}
                      className="w-full px-3 py-2.5 flex items-center gap-2 text-left
                                 hover:bg-white/[0.04] transition-colors"
                    >
                      <ChevronDown
                        className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform
                                    ${open ? "" : "-rotate-90"}`}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-white font-medium flex items-center gap-2">
                          {group.label}
                          <span className="text-[11px] text-indigo-200 bg-indigo-500/15
                                            border border-indigo-400/30 rounded-full
                                            px-1.5 py-0 tabular-nums">
                            {groupPendingCount}
                          </span>
                        </div>
                        {group.hint && (
                          <div className="text-[11px] text-gray-400 mt-0.5 truncate">
                            {group.hint}
                          </div>
                        )}
                      </div>
                    </button>
                    {/* Per-field cards inside the category */}
                    {open && (
                      <div className="border-t border-white/10 divide-y divide-white/[0.06]">
                        {groupFields.map((field) => {
                          const items = pendingByField[field] || [];
                          if (!items.length) return null;
                          const meta = fieldMeta(field);
                          const FieldIcon = meta.icon;
                          return (
                            <div key={field} className="bg-white/[0.02]">
                              <div className="px-3 py-2 border-b border-white/[0.06]">
                                <div className="flex items-center gap-2">
                                  {FieldIcon && (
                                    <FieldIcon className="w-3.5 h-3.5 text-indigo-300/80 flex-shrink-0" />
                                  )}
                                  <div className="text-xs text-gray-100 font-medium">
                                    {meta.label}
                                  </div>
                                  <div className="text-[10px] text-gray-500 font-mono ml-auto truncate max-w-[180px]">
                                    {field}
                                  </div>
                                </div>
                                {meta.hint && (
                                  <div className="text-[10px] text-gray-400 mt-0.5">{meta.hint}</div>
                                )}
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
                    )}
                  </div>
                );
              })}

              {/* Fallback flat layout — used when /soft/categories
                  failed to fetch (e.g. server old, gateway down). */}
              {!bucketed && fields.map((field) => {
                const items = pendingByField[field] || [];
                if (items.length === 0) return null;
                const meta = fieldMeta(field);
                const FieldIcon = meta.icon;
                return (
                  <div key={field}
                       className="rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden">
                    <div className="px-3 py-2.5 border-b border-white/10">
                      <div className="flex items-center gap-2">
                        {FieldIcon && <FieldIcon className="w-4 h-4 text-indigo-300 flex-shrink-0" />}
                        <div className="text-sm text-white font-medium">
                          {meta.label}
                        </div>
                        <div className="text-[11px] text-gray-500 font-mono ml-auto">{field}</div>
                      </div>
                      {meta.hint && (
                        <div className="text-[11px] text-gray-400 mt-0.5">{meta.hint}</div>
                      )}
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

            <div className="px-5 py-3 border-t border-white/10 space-y-2.5">
              <div className="text-[11px] text-gray-500">
                Approved values land in the project spec and become part of the
                Design Suite project record. Rejected ones are dropped. The agent
                will re-propose if new evidence shows up.
              </div>
              {onCreate && (
                <button
                  type="button"
                  onClick={onCreate}
                  disabled={!canCreate || creating}
                  className="w-full inline-flex items-center justify-center gap-2
                             px-3 py-2 rounded-lg text-sm font-semibold
                             bg-gradient-to-r from-indigo-500 to-violet-500
                             hover:from-indigo-400 hover:to-violet-400
                             text-white shadow-lg shadow-indigo-500/20
                             disabled:opacity-40 disabled:cursor-not-allowed
                             transition-all"
                  title={!canCreate
                    ? "Approve at least one proposal first"
                    : creating
                      ? "Creating in simorgh-soft…"
                      : "Push the approved spec to simorgh-soft and open it"}
                >
                  {creating
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <Wand2 className="w-4 h-4" />}
                  {creating
                    ? "Creating Design Suite Project…"
                    : "Create Design Suite Project"}
                </button>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

// ===========================================================================
// Row
// ===========================================================================
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
  const conf = Math.round((prop.confidence ?? 0) * 100);
  const confColor =
    conf >= 80 ? "text-emerald-300" : conf >= 50 ? "text-amber-300" : "text-rose-300";

  const rendered = renderValue(prop.field, prop.value);
  const noteParts = parseSourceNote(prop.source_note);

  // Inline edit state for primitive types only.
  const initialText = rendered.initialText ?? "";
  const current = editValue ?? initialText;
  const dirty = rendered.editable != null && current !== initialText;

  // What value to ship on approve:
  //   - edited primitive → the edited text
  //   - read-only complex → undefined (backend keeps the original value)
  const valueOnApprove =
    rendered.editable != null && dirty ? current : undefined;

  return (
    <div className="p-3 flex flex-col gap-2.5">
      {/* Top row: source pill · confidence · spacer · actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] border ${meta.accent}`}
          title={meta.tip}
        >
          <SourceIcon className="w-3 h-3" />
          {meta.label}
        </span>
        {noteParts.filename && (
          <span className="inline-flex items-center gap-1 text-[10px] text-gray-400 truncate max-w-[200px]"
                title={noteParts.filename}>
            <FileText className="w-3 h-3" /> {noteParts.filename}
          </span>
        )}
        {noteParts.section && (
          <span className="inline-flex items-center gap-1 text-[10px] text-gray-400">
            § {noteParts.section}
          </span>
        )}
        <span className={`text-[11px] font-mono ${confColor}`} title="Extractor confidence">
          {conf}%
        </span>
        {dirty && (
          <span className="inline-flex items-center gap-1 text-[10px] text-indigo-200">
            <Pencil className="w-3 h-3" /> edited
          </span>
        )}

        <div className="flex-1" />

        <button
          onClick={() => onApprove(valueOnApprove)}
          disabled={busy}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px]
                     bg-emerald-500/15 hover:bg-emerald-500/30 border border-emerald-400/40
                     text-emerald-100 transition-colors disabled:opacity-50"
          title={dirty ? "Save edit & approve" : "Approve as-is"}
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

      {/* Value display (or edit input for primitives) */}
      <div className="rounded-md bg-white/[0.02] border border-white/[0.06] p-2.5">
        {rendered.editable === "text" ? (
          <input
            type="text"
            value={current}
            onChange={(e) => onEditChange(e.target.value)}
            className="w-full bg-transparent text-white text-sm outline-none
                       focus:ring-1 focus:ring-indigo-400/50 rounded px-1 py-0.5"
          />
        ) : rendered.editable === "longtext" ? (
          <textarea
            value={current}
            onChange={(e) => onEditChange(e.target.value)}
            rows={Math.min(8, Math.max(2, current.split("\n").length + 1))}
            className="w-full bg-transparent text-white text-sm outline-none
                       focus:ring-1 focus:ring-indigo-400/50 rounded px-1 py-0.5
                       font-mono leading-relaxed"
          />
        ) : rendered.editable === "date" ? (
          <input
            type="date"
            value={current}
            onChange={(e) => onEditChange(e.target.value)}
            className="bg-transparent text-white text-sm outline-none
                       focus:ring-1 focus:ring-indigo-400/50 rounded px-1 py-0.5"
          />
        ) : (
          // Read-only complex renderer (equipments, techSettings, etc.)
          rendered.display
        )}
      </div>

      {/* Evidence pull-quote — surfaced by the Phase 2 whole-doc extractor */}
      {noteParts.evidence && (
        <div className="flex gap-2 text-[11px] text-gray-300 border-l-2 border-violet-400/40 pl-2 py-0.5">
          <Quote className="w-3 h-3 text-violet-300 flex-shrink-0 mt-0.5" />
          <span className="italic leading-relaxed">{noteParts.evidence}</span>
        </div>
      )}
    </div>
  );
}
