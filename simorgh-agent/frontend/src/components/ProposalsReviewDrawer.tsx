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
import * as XLSX from "xlsx-js-style";
import {
  X, Wand2, Check, Trash2, Pencil, Loader2, ChevronDown,
  FileText, Database, MessagesSquare, GitBranch, Server, User as UserIcon,
  Quote, Zap, Thermometer, Mountain, Activity, ShieldCheck,
  Gauge, Cable, CircuitBoard, CheckCheck, Download, Crosshair, CheckCircle2,
  AlertTriangle, RefreshCw,
} from "lucide-react";
import SourceViewer, { SourceTarget } from "./SourceViewer";

export type Proposal = {
  id:           string;
  field:        string;
  value:        any;
  source_kind:  string;
  source_note?: string;
  confidence:   number;
  doc_id?:      string | null;
  // ── Review-model metadata (present when the value was merged by the
  //    backend MDM reconciler). Optional so raw proposals still type. ──
  corroboration?: number;            // how many extractions agreed on this value
  proposal_ids?:  string[];          // every row id collapsed into this value
  sources?:       { kind: string; note?: string; confidence?: number;
                    doc_id?: string | null; proposal_id?: string }[];
  suggested?:     boolean;           // survivorship pick within a conflict
};

// One field that carries two or more DISTINCT extracted values — the user
// must choose which one survives.
export type ConflictGroup = { field: string; candidates: Proposal[] };
export type ReviewModel = {
  conflicts: ConflictGroup[];
  agreed:    Proposal[];
  counts?:   Record<string, number>;
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
  /** MDM review model (merged values + conflicts). Null = legacy layout. */
  review?:        ReviewModel | null;
  approvedCount?: number;
  busyIds?:       Set<string>;
  /** Category taxonomy from GET /soft/categories. Null = flat fallback. */
  categories?:    CategoriesResp | null;
  onApprove:      (proposal: Proposal, editedValue?: string) => void | Promise<void>;
  onReject:       (proposal: Proposal) => void | Promise<void>;
  /** Resolve a conflict: approve `chosen`, reject the `siblings`. */
  onResolveConflict?: (chosen: Proposal, siblings: Proposal[],
                       editedValue?: string) => void | Promise<void>;
  /** Push the approved spec to simorgh-soft. The drawer renders a
   *  primary footer button that calls this; disabled while creating
   *  or when no approvals exist yet. */
  onCreate?:      () => void | Promise<void>;
  creating?:      boolean;
  canCreate?:     boolean;

  // ── All-project view (not just pending conflicts) ──────────────────
  /** Already-approved values — shown in the "All" view with an Approved
   *  badge so the user reviews the WHOLE project, not just what's pending. */
  approved?:      Proposal[];
  /** Required/known fields that have no value yet (shown as gaps). */
  gaps?:          string[];
  /** Bulk decisions over every pending proposal. */
  onApproveAll?:  () => void | Promise<void>;
  onRejectAll?:   () => void | Promise<void>;
  /** Wipe all pending proposals and re-extract from the latest AI answers. */
  onClearAll?:    () => void | Promise<void>;
  bulkBusy?:      boolean;

  // ── Source markup ("show source" per item) ─────────────────────────
  projectId?:     string;
  apiBase?:       string;
  getToken?:      () => string;

  // ── Excel report header metadata ───────────────────────────────────
  projectName?:   string;
  completeness?:  number;
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

// Prettify an unknown field key into a human label: drop a known prefix,
// take the last dotted segment, split camelCase / snake_case, Title-case.
// e.g. "parameters.ratedVoltage" → "Rated voltage",
//      "techSettings.general.foo" → "Foo".
function prettifyFieldKey(field: string): string {
  const leaf = field.split(".").pop() || field;
  const spaced = leaf
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  if (!spaced) return field;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function fieldMeta(field: string): FieldMeta {
  return FIELD_META[field] || { label: prettifyFieldKey(field) };
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
  analysis:   { label: "Doc analysis",         icon: FileText,       accent: "bg-violet-500/15 text-violet-200 border-violet-400/30",
                tip:    "Mined from the agent's cited analysis of the uploaded document(s)" },
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
// Excel report — one row per project parameter with its value, review
// status, source, confidence and the evidence/document it came from.
// Covers the WHOLE project (pending + approved + still-missing gaps), not
// just what's currently under review.
// ===========================================================================
function valueToCell(value: any): string {
  if (value == null) return "";
  if (typeof value === "object") {
    if (Array.isArray(value)) {
      // Equipment arrays etc. — a compact summary beats a JSON dump.
      const n = value.length;
      const feeders = value.reduce(
        (s, e) => s + (Array.isArray(e?.devices) ? e.devices.length : 0), 0);
      return feeders ? `${n} item(s), ${feeders} feeder(s)` : `${n} item(s)`;
    }
    return Object.entries(value)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join("; ");
  }
  return String(value);
}

// Pull document / section / page / evidence out of a source_note like
//   "from analysis 'X.pdf' · § Power circuit · p.17 · \"6.6 kV\""
function parseNote(note?: string): {
  filename: string; section: string; page: string; evidence: string;
} {
  const parts = parseSourceNote(note);
  let page = "";
  const m = (note || "").match(/·\s*p\.?\s*([A-Za-z0-9.\-]+)/i)
        || (note || "").match(/\bpage\s*([A-Za-z0-9.\-]+)/i);
  if (m) page = m[1];
  return {
    filename: parts.filename || "", section: parts.section || "",
    page, evidence: parts.evidence || "",
  };
}

type RRow = {
  category: string; parameter: string; field: string; value: string;
  status: "Approved" | "Pending review" | "Not found"; source: string;
  confidence: number | "";  document: string; page: string;
  section: string; evidence: string;
};

const STATUS_ORDER: Record<RRow["status"], number> = {
  "Approved": 0, "Pending review": 1, "Not found": 2,
};

function buildRRows(
  pendingByField: Record<string, Proposal[]>,
  approved: Proposal[],
  gaps: string[],
  categories?: CategoriesResp | null,
): RRow[] {
  const sourceLabel = (k: string) => SOURCE_META[k]?.label || k || "—";
  const catOf = (field: string): string => {
    const id = categories?.field_to_category?.[field] || categories?.fallback || "other";
    const g = categories?.groups?.find((x) => x.id === id);
    return g?.label || "Other";
  };
  const rows: RRow[] = [];
  const push = (p: Proposal, status: RRow["status"]) => {
    const n = parseNote(p.source_note);
    rows.push({
      category: catOf(p.field),
      parameter: fieldMeta(p.field).label || p.field,
      field: p.field,
      value: valueToCell(p.value),
      status,
      source: sourceLabel(p.source_kind),
      confidence: Math.round((p.confidence ?? 0) * 100),
      document: n.filename, page: n.page, section: n.section, evidence: n.evidence,
    });
  };
  for (const p of approved || []) push(p, "Approved");
  for (const f of Object.keys(pendingByField || {}))
    for (const p of pendingByField[f] || []) push(p, "Pending review");
  const known = new Set(rows.map((r) => r.field));
  for (const f of gaps || []) {
    if (known.has(f)) continue;
    rows.push({
      category: catOf(f), parameter: fieldMeta(f).label || f, field: f,
      value: "", status: "Not found", source: "—", confidence: "",
      document: "", page: "", section: "", evidence: "",
    });
  }
  // Group by category (in the backend's canonical order), then status, then name.
  const catOrder: Record<string, number> = {};
  (categories?.groups || []).forEach((g, i) => { catOrder[g.label] = i; });
  rows.sort((a, b) =>
    (catOrder[a.category] ?? 99) - (catOrder[b.category] ?? 99) ||
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
    a.parameter.localeCompare(b.parameter));
  return rows;
}

// ── styling helpers (xlsx-js-style) ────────────────────────────────────────
const C = {
  brand: "1E3A8A", brand2: "3730A3", head: "1E293B", headTxt: "FFFFFF",
  stripe: "F1F5F9", white: "FFFFFF", border: "CBD5E1", line: "E2E8F0",
  okFill: "DCFCE7", okTxt: "166534", pendFill: "FEF3C7", pendTxt: "92400E",
  gapFill: "F1F5F9", gapTxt: "64748B", kpiFill: "EEF2FF", label: "475569",
};
const THIN = (rgb = C.line) => ({ style: "thin", color: { rgb } });
const BORDER_ALL = { top: THIN(), bottom: THIN(), left: THIN(), right: THIN() };

function exportProposalsExcel(
  pendingByField: Record<string, Proposal[]>,
  approved: Proposal[],
  gaps: string[],
  categories?: CategoriesResp | null,
  meta?: { projectName?: string; completeness?: number },
): void {
  const rows = buildRRows(pendingByField, approved, gaps, categories);
  const HEAD = ["Category", "Parameter", "Value", "Status", "Source",
                "Confidence", "Document", "Page", "Section",
                "Evidence / note", "Field key"];
  const NCOL = HEAD.length;
  const total = rows.length;
  const nApproved = rows.filter((r) => r.status === "Approved").length;
  const nPending = rows.filter((r) => r.status === "Pending review").length;
  const nGap = rows.filter((r) => r.status === "Not found").length;
  const srcCount: Record<string, number> = {};
  rows.forEach((r) => { if (r.source && r.source !== "—") srcCount[r.source] = (srcCount[r.source] || 0) + 1; });
  const topSources = Object.entries(srcCount).sort((a, b) => b[1] - a[1])
    .slice(0, 3).map(([s, n]) => `${s} (${n})`).join(", ") || "—";
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10);
  const projectName = meta?.projectName || "Design Suite Project";
  const completeness = typeof meta?.completeness === "number" ? `${meta.completeness}%` : "—";

  const blank = () => Array(NCOL).fill("");
  const aoa: any[][] = [];
  aoa.push(["SIMORGH AI  ·  Design Suite — Project Parameter Report", ...Array(NCOL - 1).fill("")]); // 0
  aoa.push([`${projectName}    —    generated ${now.toLocaleString()}`, ...Array(NCOL - 1).fill("")]); // 1
  aoa.push(blank());                                                          // 2
  aoa.push(["Total parameters", "Approved", "Pending review", "Not found",
            "Completeness", "Top sources", "", "", "", "", ""]);             // 3 KPI labels
  aoa.push([total, nApproved, nPending, nGap, completeness, topSources,
            "", "", "", "", ""]);                                            // 4 KPI values
  aoa.push(blank());                                                          // 5
  const HEAD_ROW = aoa.length;                                                // 6
  aoa.push(HEAD);
  const DATA_ROW = aoa.length;                                               // 7
  for (const r of rows)
    aoa.push([r.category, r.parameter, r.value, r.status, r.source,
              r.confidence === "" ? "" : r.confidence / 100, r.document,
              r.page, r.section, r.evidence, r.field]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 22 }, { wch: 30 }, { wch: 26 }, { wch: 15 }, { wch: 14 },
    { wch: 11 }, { wch: 26 }, { wch: 7 }, { wch: 22 }, { wch: 46 }, { wch: 34 },
  ];
  ws["!rows"] = [{ hpt: 30 }, { hpt: 18 }, { hpt: 6 }, { hpt: 16 }, { hpt: 22 },
                 { hpt: 6 }, { hpt: 22 }];
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: NCOL - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: NCOL - 1 } },
  ];
  ws["!autofilter"] = { ref: `${XLSX.utils.encode_cell({ r: HEAD_ROW, c: 0 })}:${XLSX.utils.encode_cell({ r: aoa.length - 1, c: NCOL - 1 })}` };

  const set = (r: number, c: number, s: any) => {
    const a = XLSX.utils.encode_cell({ r, c });
    if (!ws[a]) ws[a] = { t: "s", v: "" };
    ws[a].s = s;
  };
  // Title + subtitle
  set(0, 0, { font: { bold: true, sz: 16, color: { rgb: C.white } },
              fill: { fgColor: { rgb: C.brand } },
              alignment: { horizontal: "center", vertical: "center" } });
  set(1, 0, { font: { italic: true, sz: 10.5, color: { rgb: C.white } },
              fill: { fgColor: { rgb: C.brand2 } },
              alignment: { horizontal: "center", vertical: "center" } });
  // KPI band
  for (let c = 0; c < 6; c++) {
    set(3, c, { font: { bold: true, sz: 9, color: { rgb: C.label } },
                fill: { fgColor: { rgb: C.kpiFill } },
                alignment: { horizontal: "center" }, border: BORDER_ALL });
    const isCount = c < 4;
    set(4, c, { font: { bold: true, sz: isCount ? 14 : 11, color: { rgb: c === 1 ? C.okTxt : c === 2 ? C.pendTxt : c === 3 ? C.gapTxt : C.head } },
                fill: { fgColor: { rgb: C.white } },
                alignment: { horizontal: "center", vertical: "center" }, border: BORDER_ALL });
  }
  // Table header
  for (let c = 0; c < NCOL; c++)
    set(HEAD_ROW, c, { font: { bold: true, sz: 10, color: { rgb: C.headTxt } },
                       fill: { fgColor: { rgb: C.head } },
                       alignment: { horizontal: "center", vertical: "center", wrapText: true },
                       border: { top: THIN(C.head), bottom: THIN(C.head), left: THIN(C.border), right: THIN(C.border) } });
  // Data rows
  for (let i = 0; i < rows.length; i++) {
    const r = DATA_ROW + i;
    const rr = rows[i];
    const stripe = i % 2 === 1;
    const baseFill = stripe ? C.stripe : C.white;
    for (let c = 0; c < NCOL; c++) {
      const left = c === 1 || c === 2 || c === 9; // text columns left-aligned
      set(r, c, {
        font: { sz: 9.5, color: { rgb: "0F172A" } },
        fill: { fgColor: { rgb: baseFill } },
        alignment: { horizontal: left ? "left" : "center", vertical: "center", wrapText: c === 9 },
        border: BORDER_ALL,
      });
    }
    // Category — subtle emphasis
    set(r, 0, { font: { sz: 9, bold: true, color: { rgb: C.brand2 } },
                fill: { fgColor: { rgb: baseFill } },
                alignment: { horizontal: "left", vertical: "center" }, border: BORDER_ALL });
    // Status — colour chip
    const sFill = rr.status === "Approved" ? C.okFill : rr.status === "Pending review" ? C.pendFill : C.gapFill;
    const sTxt = rr.status === "Approved" ? C.okTxt : rr.status === "Pending review" ? C.pendTxt : C.gapTxt;
    set(r, 3, { font: { sz: 9, bold: true, color: { rgb: sTxt } },
                fill: { fgColor: { rgb: sFill } },
                alignment: { horizontal: "center", vertical: "center" }, border: BORDER_ALL });
    // Confidence — percent + colour
    if (rr.confidence !== "") {
      const conf = rr.confidence as number;
      const cTxt = conf >= 80 ? C.okTxt : conf >= 50 ? C.pendTxt : "B91C1C";
      const a = XLSX.utils.encode_cell({ r, c: 5 });
      ws[a].z = "0%";
      ws[a].s = { font: { sz: 9.5, bold: true, color: { rgb: cTxt } },
                  fill: { fgColor: { rgb: baseFill } },
                  alignment: { horizontal: "center", vertical: "center" }, border: BORDER_ALL };
    }
  }

  const wb = XLSX.utils.book_new();
  wb.Props = { Title: "Design Suite Parameter Report", Author: "Simorgh AI",
               CreatedDate: now };
  XLSX.utils.book_append_sheet(wb, ws, "Parameters");
  XLSX.writeFile(wb, `${projectName.replace(/[^\w.-]+/g, "_")}-parameters-${stamp}.xlsx`);
}

// ===========================================================================
// Drawer
// ===========================================================================
export default function ProposalsReviewDrawer({
  open, onClose, pendingByField, review, approvedCount = 0, busyIds,
  categories, onApprove, onReject, onResolveConflict,
  onCreate, creating = false, canCreate = false,
  approved = [], gaps = [], onApproveAll, onRejectAll, onClearAll, bulkBusy = false,
  projectId, apiBase, getToken, projectName, completeness,
}: Props) {
  // When the backend supplies the MDM review model, render the MERGED view:
  // identical values collapsed to one corroborated row, and fields with
  // competing values pulled out into a dedicated conflicts section. Falls
  // back to the raw pending_by_field grouping for older servers.
  const conflictGroups: ConflictGroup[] = review?.conflicts || [];
  const conflictFieldSet = React.useMemo(
    () => new Set(conflictGroups.map((c) => c.field)), [conflictGroups]);
  const effPending: Record<string, Proposal[]> = React.useMemo(() => {
    if (!review) return pendingByField;
    const m: Record<string, Proposal[]> = {};
    for (const a of review.agreed || []) (m[a.field] = m[a.field] || []).push(a);
    return m;  // one corroborated row per agreed field; conflicts excluded
  }, [review, pendingByField]);

  const fields = Object.keys(effPending).sort();
  const totalPending = fields.reduce(
    (n, f) => n + (effPending[f]?.length || 0), 0);
  const conflictCount = conflictGroups.length;
  const [edits, setEdits] = React.useState<Record<string, string>>({});
  // "pending" = only values awaiting review · "all" = the whole project.
  const [view, setView] = React.useState<"pending" | "all">("pending");
  // The proposal whose source document is open in the viewer modal.
  const [sourceTarget, setSourceTarget] = React.useState<SourceTarget | null>(null);

  const sourceEnabled = !!(projectId && apiBase && getToken);
  const showSource = (p: Proposal) => setSourceTarget({
    proposalId: p.id, field: p.field, label: fieldMeta(p.field).label || p.field,
  });
  // Only offer the source button when the value plausibly has a source
  // document (an upload, or a note that names a file).
  const hasSource = (p: Proposal) =>
    sourceEnabled && (p.source_kind === "uploads" || !!p.doc_id ||
                      !!parseSourceNote(p.source_note).filename);

  const approvedByField = React.useMemo(() => {
    const m: Record<string, Proposal[]> = {};
    for (const p of approved || []) (m[p.field] = m[p.field] || []).push(p);
    return m;
  }, [approved]);
  const gapFields = React.useMemo(
    () => (gaps || []).filter((f) => !effPending[f]?.length &&
                                     !conflictFieldSet.has(f) &&
                                     !approvedByField[f]?.length),
    [gaps, effPending, conflictFieldSet, approvedByField]);

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
      if (!effPending[f]?.length) continue;
      const cat = map[f] || fallback;
      (buckets[cat] = buckets[cat] || []).push(f);
    }
    return buckets;
  }, [fields, effPending, categories]);

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
                  {totalPending === 0 && conflictCount === 0
                    ? approvedCount > 0
                      ? `${approvedCount} value${approvedCount === 1 ? "" : "s"} approved · nothing pending`
                      : "Nothing to review right now."
                    : `${totalPending} value${totalPending === 1 ? "" : "s"} across ${fields.length} field${fields.length === 1 ? "" : "s"}`
                      + (conflictCount > 0
                          ? ` · ${conflictCount} conflict${conflictCount === 1 ? "" : "s"} to resolve`
                          : "")}
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

            {/* Toolbar — bulk decisions, Excel report, and the
                pending-vs-all view toggle. */}
            <div className="px-4 py-2 border-b border-white/10 flex items-center flex-wrap gap-2">
              <button
                onClick={onApproveAll}
                disabled={totalPending === 0 || bulkBusy || !onApproveAll}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px]
                           bg-emerald-500/15 hover:bg-emerald-500/30 border border-emerald-400/40
                           text-emerald-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title="Approve every pending value"
              >
                {bulkBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          : <CheckCheck className="w-3.5 h-3.5" />}
                Approve all{totalPending > 0 ? ` (${totalPending})` : ""}
              </button>
              <button
                onClick={onRejectAll}
                disabled={totalPending === 0 || bulkBusy || !onRejectAll}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px]
                           bg-rose-500/10 hover:bg-rose-500/25 border border-rose-400/30
                           text-rose-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title="Reject every pending value"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Reject all
              </button>
              <button
                onClick={() => {
                  if (window.confirm(
                    "Clear all current proposals and re-extract from the latest "
                    + "analysis? This removes stale/mislabelled values and rebuilds "
                    + "the list from the AI's answers.")) onClearAll?.();
                }}
                disabled={bulkBusy || !onClearAll}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px]
                           bg-amber-500/10 hover:bg-amber-500/25 border border-amber-400/30
                           text-amber-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title="Delete all proposals and re-extract cleanly from the AI's latest analysis"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Clear &amp; re-extract
              </button>

              <div className="flex-1" />

              <button
                onClick={() => exportProposalsExcel(pendingByField, approved, gaps,
                  categories, { projectName, completeness })}
                disabled={totalPending === 0 && approved.length === 0 && gapFields.length === 0}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px]
                           bg-sky-500/15 hover:bg-sky-500/30 border border-sky-400/40
                           text-sky-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title="Download an Excel report of every project parameter, its status and source"
              >
                <Download className="w-3.5 h-3.5" />
                Excel report
              </button>

              {/* Pending / All segmented toggle */}
              <div className="inline-flex rounded-lg border border-white/15 overflow-hidden text-[11px]">
                {(["pending", "all"] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => setView(v)}
                    className={`px-2.5 py-1 transition-colors ${
                      view === v ? "bg-indigo-500/30 text-white"
                                 : "text-gray-300 hover:bg-white/5"}`}
                  >
                    {v === "pending" ? "Pending" : "All data"}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {/* ── CONFLICTS — same parameter, different values. The MDM
                   reconciler couldn't auto-pick a survivor, so the user
                   decides. Shown first, highlighted, above everything. ── */}
              {conflictCount > 0 && (
                <div className="rounded-xl border border-amber-400/40 bg-amber-500/[0.06] overflow-hidden">
                  <div className="px-3 py-2.5 border-b border-amber-400/30 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-300 flex-shrink-0" />
                    <div className="text-sm text-amber-100 font-semibold">
                      Conflicts to resolve
                    </div>
                    <span className="text-[11px] text-amber-200 bg-amber-500/15
                                     border border-amber-400/30 rounded-full
                                     px-1.5 py-0 tabular-nums ml-auto">
                      {conflictCount}
                    </span>
                  </div>
                  <div className="px-3 py-2 text-[11px] text-amber-200/80 border-b border-amber-400/20">
                    These fields were extracted with more than one value. Pick the
                    correct one — the others are discarded.
                  </div>
                  <div className="divide-y divide-amber-400/15">
                    {conflictGroups.map((grp) => {
                      const meta = fieldMeta(grp.field);
                      const FieldIcon = meta.icon;
                      const anyBusy = grp.candidates.some((c) =>
                        (c.proposal_ids || [c.id]).some((id) => busyIds?.has(id)));
                      return (
                        <div key={grp.field} className="px-3 py-2.5">
                          <div className="flex items-center gap-2 mb-1.5">
                            {FieldIcon && <FieldIcon className="w-3.5 h-3.5 text-amber-300/80 flex-shrink-0" />}
                            <div className="text-xs text-amber-50 font-medium">{meta.label}</div>
                            <div className="text-[10px] text-amber-200/50 font-mono ml-auto truncate max-w-[160px]">
                              {grp.field}
                            </div>
                          </div>
                          <div className="space-y-1.5">
                            {grp.candidates.map((cand) => {
                              const rv = renderValue(cand.field, cand.value);
                              const siblings = grp.candidates.filter((c) => c !== cand);
                              return (
                                <div key={cand.id}
                                     className={`rounded-lg border px-2.5 py-2 flex items-start gap-2
                                       ${cand.suggested
                                         ? "border-emerald-400/40 bg-emerald-500/[0.05]"
                                         : "border-white/10 bg-white/[0.02]"}`}>
                                  <div className="flex-1 min-w-0">
                                    <div className="text-sm text-gray-100 break-words">{rv.display}</div>
                                    <div className="flex items-center flex-wrap gap-1 mt-1">
                                      {cand.suggested && (
                                        <span className="text-[9px] uppercase tracking-wide text-emerald-200
                                                         bg-emerald-500/15 border border-emerald-400/30
                                                         rounded px-1 py-0">Suggested</span>
                                      )}
                                      {(cand.sources && cand.sources.length
                                        ? Array.from(new Set(cand.sources.map((s) => s.kind)))
                                        : [cand.source_kind]).map((k) => (
                                        <span key={k}
                                              className="text-[9px] text-gray-300 bg-white/5
                                                         border border-white/10 rounded px-1 py-0">
                                          {SOURCE_META[k as string]?.label || k}
                                        </span>
                                      ))}
                                      {(cand.corroboration || 0) > 1 && (
                                        <span className="text-[9px] text-sky-200 bg-sky-500/10
                                                         border border-sky-400/20 rounded px-1 py-0">
                                          seen ×{cand.corroboration}
                                        </span>
                                      )}
                                      {hasSource(cand) && (
                                        <button onClick={() => showSource(cand)}
                                                className="text-[9px] text-indigo-200 hover:text-white
                                                           underline decoration-dotted">
                                          source
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                  <button
                                    disabled={anyBusy || !onResolveConflict}
                                    onClick={() => onResolveConflict?.(cand, siblings)}
                                    className="self-center inline-flex items-center gap-1 px-2 py-1 rounded-lg
                                               text-[11px] bg-emerald-500/15 hover:bg-emerald-500/30
                                               border border-emerald-400/40 text-emerald-100 transition-colors
                                               disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
                                    title="Keep this value; discard the others"
                                  >
                                    {anyBusy ? <Loader2 className="w-3 h-3 animate-spin" />
                                             : <Check className="w-3 h-3" />}
                                    Keep
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {totalPending === 0 && conflictCount === 0 &&
               (view === "pending" || (approved.length === 0 && gapFields.length === 0)) && (
                <div className="mt-10 text-center text-sm text-gray-400 max-w-sm mx-auto">
                  As the agent extracts values from your spec PDFs, TPMS, or
                  chat, they'll appear here — each one with its source and
                  evidence — for you to approve before it's saved to the
                  project. Switch to <span className="text-indigo-300">All data</span> to
                  see every project parameter, including approved values.
                </div>
              )}

              {/* Category-grouped layout (preferred) — falls back to the
                  flat per-field cards below when /soft/categories was
                  unreachable at app load. */}
              {bucketed && categories && categories.groups.map((group) => {
                const groupFields = bucketed[group.id] || [];
                const groupPendingCount = groupFields.reduce(
                  (n, f) => n + (effPending[f]?.length || 0), 0);
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
                          const items = effPending[field] || [];
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
                                    onShowSource={hasSource(prop) ? () => showSource(prop) : undefined}
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
                const items = effPending[field] || [];
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
                          onShowSource={hasSource(prop) ? () => showSource(prop) : undefined}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}

              {/* ── ALL-DATA VIEW: already-approved values ───────────────
                  So the user reviews the WHOLE project, not just pending
                  conflicts. Read-only (approved values are locked in; the
                  agent re-proposes if new evidence appears). */}
              {view === "all" && approved.length > 0 && (
                <div className="rounded-xl border border-emerald-400/20 bg-emerald-500/[0.04] overflow-hidden">
                  <div className="px-3 py-2 border-b border-emerald-400/15 flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-300" />
                    <span className="text-sm text-emerald-100 font-medium">Approved values</span>
                    <span className="text-[11px] text-emerald-200/80 ml-auto tabular-nums">
                      {approved.length}
                    </span>
                  </div>
                  <div className="divide-y divide-white/[0.06]">
                    {Object.keys(approvedByField).sort().map((field) => {
                      const items = approvedByField[field];
                      const meta = fieldMeta(field);
                      return items.map((prop) => {
                        const r = renderValue(prop.field, prop.value);
                        const sm = SOURCE_META[prop.source_kind] || SOURCE_META.default;
                        const note = parseSourceNote(prop.source_note);
                        return (
                          <div key={prop.id} className="px-3 py-2 flex items-start gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-xs text-gray-200 font-medium">{meta.label}</span>
                                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] border ${sm.accent}`}>
                                  {sm.label}
                                </span>
                                {note.filename && (
                                  <span className="text-[10px] text-gray-400 inline-flex items-center gap-1 truncate max-w-[160px]">
                                    <FileText className="w-3 h-3" /> {note.filename}
                                  </span>
                                )}
                              </div>
                              <div className="text-xs text-gray-100 mt-0.5">{r.display}</div>
                            </div>
                            {hasSource(prop) && (
                              <button
                                onClick={() => showSource(prop)}
                                className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px]
                                           bg-white/5 hover:bg-white/10 border border-white/15 text-gray-200"
                                title="Show the source page with the extracted area highlighted"
                              >
                                <Crosshair className="w-3 h-3" /> Source
                              </button>
                            )}
                          </div>
                        );
                      });
                    })}
                  </div>
                </div>
              )}

              {/* ── ALL-DATA VIEW: still-missing parameters ──────────────── */}
              {view === "all" && gapFields.length > 0 && (
                <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
                  <div className="px-3 py-2 border-b border-white/10 flex items-center gap-2">
                    <span className="text-sm text-gray-200 font-medium">Not found yet</span>
                    <span className="text-[11px] text-gray-400 ml-auto tabular-nums">
                      {gapFields.length}
                    </span>
                  </div>
                  <div className="px-3 py-2 flex flex-wrap gap-1.5">
                    {gapFields.map((f) => (
                      <span key={f}
                            className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px]
                                       bg-amber-500/10 text-amber-100 border border-amber-400/20">
                        {fieldMeta(f).label || f}
                      </span>
                    ))}
                  </div>
                </div>
              )}
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

          {/* Source document viewer — opened by the per-row "Source" button. */}
          {sourceEnabled && (
            <SourceViewer
              open={!!sourceTarget}
              target={sourceTarget}
              projectId={projectId!}
              apiBase={apiBase!}
              getToken={getToken!}
              onClose={() => setSourceTarget(null)}
            />
          )}
        </>
      )}
    </AnimatePresence>
  );
}

// ===========================================================================
// Row
// ===========================================================================
function ProposalRow({
  prop, editValue, busy, onEditChange, onApprove, onReject, onShowSource,
}: {
  prop:         Proposal;
  editValue:    string | undefined;
  busy:         boolean;
  onEditChange: (v: string) => void;
  onApprove:    (editedValue?: string) => void;
  onReject:     () => void;
  /** When set, render a "Source" button that opens the marked-up source doc. */
  onShowSource?: () => void;
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
        {(prop.corroboration || 0) > 1 && (
          <span className="inline-flex items-center gap-1 text-[10px] text-sky-200
                           bg-sky-500/10 border border-sky-400/20 rounded-full px-1.5 py-0"
                title={`This value was extracted ${prop.corroboration} times across sources and merged`}>
            <CheckCheck className="w-3 h-3" /> ×{prop.corroboration}
          </span>
        )}
        {dirty && (
          <span className="inline-flex items-center gap-1 text-[10px] text-indigo-200">
            <Pencil className="w-3 h-3" /> edited
          </span>
        )}

        <div className="flex-1" />

        {onShowSource && (
          <button
            onClick={onShowSource}
            disabled={busy}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px]
                       bg-white/5 hover:bg-white/10 border border-white/15
                       text-gray-200 transition-colors disabled:opacity-50"
            title="Show the source page with the extracted area highlighted"
          >
            <Crosshair className="w-3.5 h-3.5" />
            Source
          </button>
        )}
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
