// Hierarchical Template Wizard — walks the user step-by-step down the
// equipment-classification tree the team uses, and at every step shows
// existing templates that already live at the same path. The user can
// either pick one (creates a clone with a fresh name) or proceed and
// create a brand-new template at the chosen leaf.
//
// LV taxonomy (top → leaf):
//   family    : OFW | FIX
//   root      : S8 | 8PT   (both families — same options either way)
//   OFW  switch  : MOTOR | FEEDER | FCB1 | FCB2 | FCB3 | MODULLAR | FCB-CAP
//   OFW  feeder  : (only under FCB1/2/3) INCOMING | OUTGOING | COUPLING
//   FIX  group   : CCS | OFF | MARSHALING | SWING
//   FIX  feeder  : (all but MARSHALING) INCOMING | COUPLING | METERING |
//                  RISER | MET&RISER | OUTGOING
//   leafKind  : OFW MOTOR/FEEDER → answered by the switch step itself
//               OFW FCB Outgoing → motor | transformer
//               FIX Outgoing → motor | transformer | capacitor
//               everything else under LV → none (nothing further to ask)
//   params    : kW + currentA
//
// MV taxonomy:
//   cellType  : Feeder Truck | Incoming VT Cell | Disconnector Link |
//               Coupling Truck | Riser Connection | Metering Riser
//               Connection | Metering | Dummy | Support Instead of CT
//   cellSub   : (Feeder Truck) Circuit Breaker | Contactor Fuse Combination
//               (Disconnector Link) With Fuse | Without Fuse
//   leafKind  : (Feeder Truck → Circuit Breaker only) motor | transformer |
//               capacitor — Contactor Fuse Combination is fixed to motor,
//               with no chip step shown for it; everything else has none.
//   params    : kW + currentA
//
// The wizard never blocks creation — if a step doesn't apply for the tier
// or branch (e.g. MV has no root), it's skipped. Suggested templates are
// scored by leafKind match + |Δkw| + |Δcurrent|.

import React, { useMemo, useState } from 'react';
import { XIcon, ChevronRightIcon, SparklesIcon, CheckIcon } from 'lucide-react';
import {
  TemplateItem, TemplateHierarchy, TemplateLeafKind, TemplateMechanical,
} from '../../types/project';
import { TEMPLATE_FAMILIES, foldedPath, familyOf } from '../../utils/templateFamilies';
import { MechanicalQuestions } from './MechanicalQuestions';
import { type Tier } from '../../utils/tiers';

const LV_ROOTS       = ['S8', '8PT'] as const;
// SFD and HFD used to head this list, and each of them asked exactly one
// further question — motor or feeder — with nothing else underneath. Two
// levels to say one thing. They are gone, and the question that was under them
// has moved up into their place: MOTOR and FEEDER are picked here directly.
const LV_OFW_PROMOTED = ['MOTOR', 'FEEDER'] as const;
const LV_OFW_SWITCHES = [...LV_OFW_PROMOTED, 'FCB1', 'FCB2', 'FCB3', 'MODULLAR', 'FCB-CAP'] as const;

/** The leaf kind a promoted switch node already answers, if it is one. */
const promotedKind = (node: string | null): TemplateLeafKind | null =>
  node === 'MOTOR' ? 'motor' : node === 'FEEDER' ? 'feeder' : null;
// Of the OFW switches, only these three get an Incoming/Outgoing/Coupling
// sub-step — MODULLAR and FCB-CAP already say what they are.
const LV_OFW_FEEDER_SWITCHES = ['FCB1', 'FCB2', 'FCB3'];
const LV_FIX_GROUPS  = ['CCS', 'OFF', 'MARSHALING', 'SWING'] as const;
const LV_FCB_FEEDERS = ['INCOMING', 'OUTGOING', 'COUPLING'] as const;
const LV_FIX_FEEDERS = ['INCOMING', 'COUPLING', 'METERING', 'RISER', 'MET&RISER', 'OUTGOING'] as const;

const MV_CELL_TYPES = [
  'Feeder Truck', 'Incoming VT Cell', 'Disconnector Link', 'Coupling Truck',
  'Riser Connection', 'Metering Riser Connection', 'Metering', 'Dummy',
  'Support Instead of CT',
] as const;
const MV_FEEDER_TRUCK_SUB = ['Circuit Breaker', 'Contactor Fuse Combination'] as const;
const MV_DISCONNECTOR_SUB = ['With Fuse', 'Without Fuse'] as const;

const needsCellSub = (cellType: string | null) =>
  cellType === 'Feeder Truck' || cellType === 'Disconnector Link';
const cellSubOptions = (cellType: string | null): readonly string[] =>
  cellType === 'Feeder Truck' ? MV_FEEDER_TRUCK_SUB
  : cellType === 'Disconnector Link' ? MV_DISCONNECTOR_SUB
  : [];

// GIS cells are MV cells in a different enclosure — the same cell types, the
// same sub-types — so a GIS template is filed exactly as a MV one is.
const mvLike = (tier: Tier) => tier === 'MV' || tier === 'GIS';

// Which leaf kinds are valid for the path drilled into so far — empty means
// nothing further to ask, the path is already complete on its own.
function allowedLeafKinds(
  tier: Tier,
  ctx: {
    family: string | null; switchNode: string | null; group: string | null;
    feeder: string | null; cellType: string | null; cellSub: string | null;
  },
): TemplateLeafKind[] {
  if (mvLike(tier)) {
    if (ctx.cellType === 'Feeder Truck' && ctx.cellSub === 'Circuit Breaker') {
      return ['motor', 'transformer', 'capacitor'];
    }
    return [];
  }
  if (tier === 'LV') {
    if (ctx.family === 'OFW') {
      // MOTOR and FEEDER are the answer, not the question — picking one is
      // what used to be the step after SFD or HFD, so there is nothing left
      // to ask. (SFD and HFD themselves can no longer be reached; templates
      // filed under one before the fold keep working, they just cannot be
      // made any more.)
      if (promotedKind(ctx.switchNode)) return [];
      if (ctx.switchNode && LV_OFW_FEEDER_SWITCHES.includes(ctx.switchNode)) {
        return ctx.feeder === 'OUTGOING' ? ['motor', 'transformer'] : [];
      }
      return []; // MODULLAR, FCB-CAP
    }
    if (ctx.family === 'FIX') {
      if (ctx.group === 'MARSHALING') return [];
      return ctx.feeder === 'OUTGOING' ? ['motor', 'transformer', 'capacitor'] : [];
    }
  }
  return [];
}

/**
 * A stored path read back into the steps that produced it.
 *
 * Used when a template is pasted: the copy starts where its original sits, so
 * only what actually differs — usually the name — has to be typed. A node the
 * step does not offer is dropped rather than forced in, which is what happens
 * to a path pasted into a section that does not file it: the person picks the
 * new one, because only they know which group of the new section it belongs in.
 */
function seedPath(
  tier: Tier,
  family: string | null,
  path: readonly string[],
): {
  root: string | null; switchNode: string | null; group: string | null;
  feeder: string | null; cellType: string | null; cellSub: string | null;
} {
  const empty = {
    root: null, switchNode: null, group: null,
    feeder: null, cellType: null, cellSub: null,
  };
  const at = (i: number) => String(path[i] ?? '').toUpperCase();
  const pick = (value: string, options: readonly string[]) =>
    options.find(o => o.toUpperCase() === value) ?? null;

  if (tier === 'LV') {
    if (family === 'OFW') {
      const switchNode = pick(at(1), LV_OFW_SWITCHES);
      return {
        ...empty,
        root: pick(at(0), LV_ROOTS),
        switchNode,
        feeder: switchNode && LV_OFW_FEEDER_SWITCHES.includes(switchNode)
          ? pick(at(2), LV_FCB_FEEDERS) : null,
      };
    }
    if (family === 'FIX') {
      const group = pick(at(1), LV_FIX_GROUPS);
      return {
        ...empty,
        root: pick(at(0), LV_ROOTS),
        group,
        feeder: group && group !== 'MARSHALING' ? pick(at(2), LV_FIX_FEEDERS) : null,
      };
    }
    return empty;
  }
  if (mvLike(tier)) {
    const cellType = pick(at(0), MV_CELL_TYPES);
    return {
      ...empty,
      cellType,
      cellSub: cellType ? pick(at(1), cellSubOptions(cellType)) : null,
    };
  }
  return empty;
}

function scoreSimilarity(
  candidate: TemplateItem,
  draft: TemplateHierarchy,
): number {
  let score = 0;
  if (candidate.hierarchy?.leafKind && candidate.hierarchy.leafKind === draft.leafKind) score += 100;
  const dk = parseFloat(String(candidate.hierarchy?.params?.kw ?? ''));
  const dr = parseFloat(String(draft.params?.kw ?? ''));
  if (!isNaN(dk) && !isNaN(dr)) score -= Math.abs(dk - dr);
  const dca = parseFloat(String(candidate.hierarchy?.params?.currentA ?? ''));
  const dcb = parseFloat(String(draft.params?.currentA ?? ''));
  if (!isNaN(dca) && !isNaN(dcb)) score -= Math.abs(dca - dcb);
  return score;
}

interface Props {
  tier: Tier;
  /**
   * The section the template is being made in — OFW or FIX for LV.
   *
   * Decided by where it was started from: the tree makes a template from
   * inside the section it belongs to, so there is nothing to ask here. Left
   * out only by a caller that has no section to give, and then the step comes
   * back rather than leaving the wizard with nowhere to go.
   */
  family?: string | null;
  /** All existing templates for this tier (used for suggestions). */
  existing: TemplateItem[];
  /**
   * The template being pasted, if this was opened by a paste.
   *
   * Its parts, its parameters and its mechanical answers come with it, and
   * its path comes too when the section it is being pasted into is the one
   * it was already filed in. Only a template of this tier can ever arrive
   * here — a LV template's columns are not a MV template's, so the paste is
   * refused where it is offered, not here.
   */
  startFrom?: TemplateItem | null;
  /**
   * `move` re-files the template that was cut; `copy` makes a new one;
   * `edit` changes the template that is already there and keeps its id.
   *
   * Editing is what the path, the leaf and the parameters were missing: they
   * could be chosen once, when the template was made, and after that the only
   * way to correct a wrong Root or a rated power typed with a digit missing
   * was to delete the template and build it again — losing its parts and its
   * place in the tree with it.
   */
  pasteMode?: 'copy' | 'move' | 'edit';
  onCancel: () => void;
  /** `copyFromId` populated when the user picked an existing template
   *  as the starting point. */
  onSubmit: (args: {
    name: string;
    hierarchy: TemplateHierarchy;
    useSimorghDraw: boolean;
    /** What the estimate sheets ask that the columns do not answer. */
    mechanical: TemplateMechanical;
    copyFromId?: string;
  }) => void;
}

export const HierarchicalTemplateWizard: React.FC<Props> = ({
  tier, family: givenFamily = null, existing, startFrom = null,
  pasteMode = 'copy', onCancel, onSubmit,
}) => {
  // Where a pasted template's path can be reused: only when it is being
  // filed back into the section it already belongs to. A OFW path pasted
  // into FIX names nodes FIX has not got, so it is not carried over.
  const seed = seedPath(
    tier,
    givenFamily,
    startFrom && (tier !== 'LV' || familyOf('LV', startFrom.hierarchy)?.id === givenFamily)
      ? foldedPath(startFrom.hierarchy?.path)
      : [],
  );
  // Path nodes — present iff the tier exposes that step.
  const [family,  setFamily]  = useState<string | null>(givenFamily); // OFW | FIX (LV only)
  const askFamily = tier === 'LV' && !givenFamily;
  const section = TEMPLATE_FAMILIES[tier]?.find(f => f.id === family) ?? null;
  const [root,    setRoot]    = useState<string | null>(seed.root);       // S8 | 8PT (LV only, both families)
  const [switch_, setSwitch]  = useState<string | null>(seed.switchNode); // OFW only
  const [group,   setGroup]   = useState<string | null>(seed.group);      // FIX only
  const [feeder,  setFeeder]  = useState<string | null>(seed.feeder);     // OFW/FCBn or FIX non-Marshaling
  const [cellType, setCellType] = useState<string | null>(seed.cellType); // MV only
  const [cellSub,  setCellSub]  = useState<string | null>(seed.cellSub);  // MV only
  const [leafKind, setLeafKind] = useState<TemplateLeafKind | null>(
    (startFrom?.hierarchy?.leafKind as TemplateLeafKind | undefined) ?? null);
  const [kw, setKw] = useState(startFrom?.hierarchy?.params?.kw ?? '');
  const [currentA, setCurrentA] = useState(startFrom?.hierarchy?.params?.currentA ?? '');
  // A move and an edit keep the name they had; a copy says it is one, so the
  // tree does not show two rows that read the same.
  const [name, setName] = useState(
    startFrom ? (pasteMode === 'copy' ? `${startFrom.name} copy` : startFrom.name) : '');
  // Either way the equipment draws — this only decides whether the extra
  // per-equipment questions (a separate, later piece of work) get asked.
  /**
   * Answered Yes to begin with, and never in the way.
   *
   * It used to start unanswered and Create was disabled until it was — with
   * nothing on screen saying so, because every step above it showed a tick and
   * the button's own tooltip said "pick a path and enter a name first", both
   * of which had been done. A template could not be made and the screen would
   * not say why.
   *
   * Either way the equipment draws: this only decides whether the extra
   * per-equipment questions get asked later, and this office draws with
   * Simorgh Draw. So it is a default to change, not a gate to pass.
   */
  const [useSimorghDraw, setUseSimorghDraw] = useState<boolean>(
    startFrom?.useSimorghDraw ?? true);
  // The mechanical answers. Never required: a template with none behaves
  // exactly as one made before this step existed, because every fact it
  // would have overruled is read from the columns instead.
  const [mechanical, setMechanical] = useState<TemplateMechanical>(
    { ...(startFrom?.mechanical ?? {}) });

  const feederApplies = tier === 'LV' && (
    (family === 'OFW' && !!switch_ && LV_OFW_FEEDER_SWITCHES.includes(switch_)) ||
    (family === 'FIX' && !!group && group !== 'MARSHALING')
  );
  const feederOptions: readonly string[] = family === 'OFW' ? LV_FCB_FEEDERS : LV_FIX_FEEDERS;

  // Build the path array as the user descends.
  const path = useMemo(() => {
    const p: string[] = [];
    if (tier === 'LV') {
      if (root) p.push(root);
      if (family === 'OFW') {
        if (switch_) p.push(switch_);
      } else if (family === 'FIX') {
        if (group) p.push(group);
      }
      if (feeder) p.push(feeder);
    } else if (mvLike(tier)) {
      if (cellType) p.push(cellType);
      if (cellSub) p.push(cellSub);
    }
    return p;
  }, [tier, root, family, switch_, group, feeder, cellType, cellSub]);

  const candidateLeafKinds = allowedLeafKinds(tier, { family, switchNode: switch_, group, feeder, cellType, cellSub });

  // True once every structural step this branch requires has an answer —
  // independent of leafKind, which may legitimately be "nothing to ask".
  const structuralPathComplete = mvLike(tier)
    ? !!cellType && (!needsCellSub(cellType) || !!cellSub)
    // A group with no path steps of its own (HV, OTHER) is complete as soon
    // as it is opened — there is nothing to drill into, only a name to give.
    : tier !== 'LV' ? true
    : !!root
      && (family === 'OFW' ? !!switch_ : family === 'FIX' ? !!group : false)
      && (!feederApplies || !!feeder);

  // Which step are we on? The first step missing a value is the active one.
  type Step = 'family' | 'root' | 'switch' | 'group' | 'feeder'
    | 'cellType' | 'cellSub' | 'kind' | 'params' | 'mechanical' | 'name';
  const activeStep: Step = (() => {
    if (tier === 'LV') {
      if (!family) return 'family';
      if (!root) return 'root';
      if (family === 'OFW' && !switch_) return 'switch';
      if (family === 'FIX' && !group) return 'group';
      if (feederApplies && !feeder) return 'feeder';
    }
    if (mvLike(tier)) {
      if (!cellType) return 'cellType';
      if (needsCellSub(cellType) && !cellSub) return 'cellSub';
    }
    if (candidateLeafKinds.length > 0 && !leafKind) return 'kind';
    if (!kw && !currentA) return 'params';
    // Mechanical is optional, so it holds the cursor only while nothing has
    // been answered and nothing after it has been either — answering the next
    // step is how it is skipped, rather than a step that has to be dismissed.
    // Mechanical and the Draw question are both optional, so neither holds
    // the cursor: once the parameters are in, the name is what is left.
    if (Object.keys(mechanical).length === 0) return 'mechanical';
    return 'name';
  })();

  // Score & rank suggestions at the current path so the user sees real
  // proposals refine as they go deeper.
  const suggestions = useMemo(() => {
    if (path.length === 0) return [];
    const draft: TemplateHierarchy = {
      path, leafKind: leafKind || undefined,
      params: { kw: kw || undefined, currentA: currentA || undefined },
    };
    // A template filed before the fold said "motor" in its leaf kind and "SFD"
    // in its path. Folding the path alone would leave it one step short of the
    // new S8 / MOTOR and drop the entire old library out of the suggestions,
    // so where the step is a promoted one the leaf kind answers for it.
    const promoted = promotedKind(path[path.length - 1] ?? null);
    const stem = promoted ? path.slice(0, -1) : path;
    return existing
      .filter(t => promoted ? t.hierarchy?.leafKind === promoted : true)
      .filter(t => {
        if (!t.hierarchy?.path) return false;
        const p = foldedPath(t.hierarchy.path);
        // Match path PREFIX so partial matches still show up as you drill in.
        if (p.length < stem.length) return false;
        return stem.every((step, i) => String(p[i]).toLowerCase() === step.toLowerCase());
      })
      .map(t => ({ template: t, score: scoreSimilarity(t, draft) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }, [existing, path, leafKind, kw, currentA]);

  // Step UI helpers ───────────────────────────────────────────────────────
  // Numbering counts the steps that are actually on screen. Which ones those
  // are depends on the tier and on how far down the path the user is.
  const visibleSteps: string[] = [
    askFamily && 'family',
    tier === 'LV' && 'root',
    tier === 'LV' && family === 'OFW' && 'switch',
    tier === 'LV' && family === 'FIX' && 'group',
    feederApplies && 'feeder',
    mvLike(tier) && 'cellType',
    mvLike(tier) && needsCellSub(cellType) && 'cellSub',
    candidateLeafKinds.length > 0 && 'kind',
    structuralPathComplete && 'params',
    structuralPathComplete && 'mechanical',
    'simorghDraw',
    'name',
  ].filter(Boolean) as string[];

  const stepNumber = (id: string) => Math.max(1, visibleSteps.indexOf(id) + 1);

  const StepHeader: React.FC<{ n: number; label: string; done?: boolean; active?: boolean }> = ({ n, label, done, active }) => (
    <div className={`flex items-center gap-2 text-xs ${
      active ? 'text-blue-700 font-semibold'
      : done ? 'text-emerald-700'
      : 'text-gray-400'
    }`}>
      <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
        active ? 'bg-blue-600 text-white'
        : done ? 'bg-emerald-500 text-white'
        : 'bg-gray-200'
      }`}>
        {done ? <CheckIcon className="w-3 h-3" /> : n}
      </span>
      <span>{label}</span>
    </div>
  );

  const PathBreadcrumb: React.FC = () => (
    <div className="flex items-center gap-1 flex-wrap text-xs text-gray-600">
      <span className="font-semibold text-gray-500">{tier}</span>
      {section && (
        <>
          <ChevronRightIcon className="w-3 h-3 text-gray-400" />
          <span className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 font-medium">
            {section.label}
          </span>
        </>
      )}
      {path.map((p, i) => (
        <React.Fragment key={i}>
          <ChevronRightIcon className="w-3 h-3 text-gray-400" />
          <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-medium">{p}</span>
        </React.Fragment>
      ))}
      {leafKind && (
        <>
          <ChevronRightIcon className="w-3 h-3 text-gray-400" />
          <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 font-medium">{leafKind}</span>
        </>
      )}
    </div>
  );

  const Chip: React.FC<{ value: string; selected: boolean; onClick: () => void }> = ({ value, selected, onClick }) => (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
        selected
          ? 'bg-blue-600 text-white border-blue-700'
          : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100'
      }`}
    >
      {value}
    </button>
  );

  // Reset deeper choices when an ancestor step is changed.
  const pickFamily = (f: string) => {
    setFamily(f);
    setRoot(null); setSwitch(null); setGroup(null); setFeeder(null); setLeafKind(null);
  };
  // The root is the only step nothing below it depends on: S8 and 8PT offer
  // the same switches, the same groups and the same feeders. So changing it
  // keeps what has already been chosen instead of emptying the path — which
  // on a template being edited was the difference between correcting one
  // answer and re-entering all of them.
  const pickRoot = (r: string) => setRoot(r);
  // Picking MOTOR or FEEDER here *is* the leaf kind — the step it replaced is
  // the one that used to ask for it — so it is recorded as one. Everything
  // downstream that ranks or describes a template by its leaf kind goes on
  // working, which is the whole point of folding the level rather than
  // dropping what it was for.
  const pickSwitch = (s: string) => {
    setSwitch(s);
    setFeeder(null);
    setLeafKind(promotedKind(s));
  };
  const pickGroup  = (g: string) => { setGroup(g); setFeeder(null); setLeafKind(null); };
  const pickFeeder = (f: string) => { setFeeder(f); setLeafKind(null); };
  const pickCellType = (c: string) => { setCellType(c); setCellSub(null); setLeafKind(null); };
  const pickCellSub = (s: string) => {
    setCellSub(s);
    // Contactor Fuse Combination is fixed to motor — no chip step for it.
    setLeafKind(cellType === 'Feeder Truck' && s === 'Contactor Fuse Combination' ? 'motor' : null);
  };

  const canCreate = name.trim().length > 0 && structuralPathComplete;
  /** What is still missing, so a disabled button can say so rather than guess. */
  const missing = !structuralPathComplete
    ? 'Pick the rest of the path above'
    : !name.trim() ? 'Give it a name' : '';

  const handleCreate = (copyFromId?: string) => {
    if (!canCreate) return;
    onSubmit({
      name: name.trim(),
      hierarchy: {
        path,
        leafKind: leafKind || undefined,
        params: {
          kw: kw || undefined,
          currentA: currentA || undefined,
        },
      },
      useSimorghDraw: !!useSimorghDraw,
      mechanical,
      // A paste brings the source with it even when the button that started
      // it was not one of the suggestions.
      copyFromId: copyFromId ?? startFrom?.id,
    });
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-[200]" onClick={onCancel}>
      <div
        className="bg-white rounded-lg shadow-2xl w-[720px] max-h-[90vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-indigo-600 to-purple-600 text-white px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <SparklesIcon className="w-5 h-5" />
            <h2 className="text-base font-semibold">
              {startFrom
                ? `${pasteMode === 'edit' ? 'Edit' : pasteMode === 'move' ? 'Move' : 'Paste'} ${tier} Template${section ? ` — ${section.label}` : ''}`
                : `New ${tier} Template${section ? ` — ${section.label}` : ''}`}
            </h2>
          </div>
          <button onClick={onCancel} className="p-1 rounded hover:bg-white/20">
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        {/* Breadcrumb */}
        <div className="px-5 py-2 border-b bg-gray-50">
          <PathBreadcrumb />
        </div>

        {/* What is being pasted, and what came with it. Said plainly, because
            the parts arriving with the template are the reason to paste it
            and are the one thing the steps below never show. */}
        {startFrom && (
          <div className="px-5 py-2 border-b bg-indigo-50/70 text-[11px] text-indigo-900">
            {pasteMode === 'edit' ? 'Editing' : pasteMode === 'move' ? 'Moving' : 'Copying'}{' '}
            <span className="font-semibold">{startFrom.name}</span>
            {pasteMode === 'edit'
              ? ' — its parts stay as they are; the path, the leaf and the parameters below are what is being changed.'
              : ' — its parts, parameters and mechanical answers come with it.'}
            {tier === 'LV' && !seed.root && (
              <span className="block text-indigo-700">
                Its path is not one this section files, so pick the new one below.
              </span>
            )}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Step — System (only when the caller had none to give) */}
          {askFamily && (
            <div>
              <StepHeader n={stepNumber('family')} label="System" active={activeStep === 'family'} done={!!family} />
              <div className="mt-2 flex flex-wrap gap-2">
                {TEMPLATE_FAMILIES.LV.map(f => (
                  <Chip key={f.id} value={f.label} selected={family === f.id} onClick={() => pickFamily(f.id)} />
                ))}
              </div>
              <p className="mt-1 text-[10px] text-gray-400 italic">
                {TEMPLATE_FAMILIES.LV.map(f => `${f.label} — ${f.note}`).join(' · ')}
              </p>
            </div>
          )}

          {/* Step — Root (both LV families) */}
          {tier === 'LV' && (family === 'OFW' || family === 'FIX') && (
            <div>
              <StepHeader n={stepNumber('root')} label="Root" active={activeStep === 'root'} done={!!root} />
              <div className="mt-2 flex flex-wrap gap-2">
                {LV_ROOTS.map(r => (
                  <Chip key={r} value={r} selected={root === r} onClick={() => pickRoot(r)} />
                ))}
              </div>
            </div>
          )}

          {/* Step — Switch (OFW only) */}
          {tier === 'LV' && family === 'OFW' && !!root && (
            <div>
              <StepHeader n={stepNumber('switch')} label="Switch" active={activeStep === 'switch'} done={!!switch_} />
              <div className="mt-2 flex flex-wrap gap-2">
                {LV_OFW_SWITCHES.map(s => (
                  <Chip key={s} value={s} selected={switch_ === s} onClick={() => pickSwitch(s)} />
                ))}
              </div>
            </div>
          )}

          {/* Step — Group (FIX only) */}
          {tier === 'LV' && family === 'FIX' && !!root && (
            <div>
              <StepHeader n={stepNumber('group')} label="Group" active={activeStep === 'group'} done={!!group} />
              <div className="mt-2 flex flex-wrap gap-2">
                {LV_FIX_GROUPS.map(g => (
                  <Chip key={g} value={g} selected={group === g} onClick={() => pickGroup(g)} />
                ))}
              </div>
            </div>
          )}

          {/* Step — Feeder (OFW/FCBn or FIX non-Marshaling) */}
          {feederApplies && (
            <div>
              <StepHeader n={stepNumber('feeder')} label="Feeder" active={activeStep === 'feeder'} done={!!feeder} />
              <div className="mt-2 flex flex-wrap gap-2">
                {feederOptions.map(f => (
                  <Chip key={f} value={f} selected={feeder === f} onClick={() => pickFeeder(f)} />
                ))}
              </div>
            </div>
          )}

          {/* Step — Cell type (MV) */}
          {mvLike(tier) && (
            <div>
              <StepHeader n={stepNumber('cellType')} label="Cell Type" active={activeStep === 'cellType'} done={!!cellType} />
              <div className="mt-2 flex flex-wrap gap-2">
                {MV_CELL_TYPES.map(c => (
                  <Chip key={c} value={c} selected={cellType === c} onClick={() => pickCellType(c)} />
                ))}
              </div>
            </div>
          )}

          {/* Step — Cell sub-type (Feeder Truck / Disconnector Link) */}
          {mvLike(tier) && needsCellSub(cellType) && (
            <div>
              <StepHeader n={stepNumber('cellSub')} label={cellType === 'Feeder Truck' ? 'Feeder Truck type' : 'Disconnector Link'} active={activeStep === 'cellSub'} done={!!cellSub} />
              <div className="mt-2 flex flex-wrap gap-2">
                {cellSubOptions(cellType).map(s => (
                  <Chip key={s} value={s} selected={cellSub === s} onClick={() => pickCellSub(s)} />
                ))}
              </div>
              {cellType === 'Feeder Truck' && cellSub === 'Contactor Fuse Combination' && (
                <p className="mt-1 text-[10px] text-gray-400 italic">Fixed to motor — nothing further to choose.</p>
              )}
            </div>
          )}

          {/* Step — Leaf kind (only when the branch actually has one) */}
          {candidateLeafKinds.length > 0 && (
            <div>
              <StepHeader n={stepNumber('kind')} label="Equipment kind" active={activeStep === 'kind'} done={!!leafKind} />
              <div className="mt-2 flex flex-wrap gap-2">
                {candidateLeafKinds.map(k => (
                  <Chip key={k} value={k} selected={leafKind === k} onClick={() => setLeafKind(k)} />
                ))}
              </div>
              <p className="mt-1 text-[10px] text-gray-400 italic">
                Categorisation depends on the path you picked above.
              </p>
            </div>
          )}

          {/* Step — Parameters */}
          {structuralPathComplete && (
            <div>
              <StepHeader n={stepNumber('params')} label="Parameters" active={activeStep === 'params'} done={!!(kw || currentA)} />
              <div className="mt-2 grid grid-cols-2 gap-3">
                <label className="text-xs">
                  <span className="text-gray-600">Rated power (kW / kVA)</span>
                  <input
                    type="text"
                    value={kw}
                    onChange={e => setKw(e.target.value)}
                    placeholder="e.g. 22"
                    className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-400"
                  />
                </label>
                <label className="text-xs">
                  <span className="text-gray-600">Full-load current (A)</span>
                  <input
                    type="text"
                    value={currentA}
                    onChange={e => setCurrentA(e.target.value)}
                    placeholder="e.g. 44"
                    className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-400"
                  />
                </label>
              </div>
            </div>
          )}

          {/* Suggestions (live as path narrows). Not while editing: "use this
              one as a starting point" makes a new template, which is the one
              thing an edit must not do. */}
          {pasteMode !== 'edit' && suggestions.length > 0 && (
            <div className="rounded border border-amber-200 bg-amber-50/60">
              <div className="px-3 py-2 border-b border-amber-200 flex items-center gap-2">
                <SparklesIcon className="w-4 h-4 text-amber-600" />
                <span className="text-xs font-semibold text-amber-800">
                  {suggestions.length} similar template{suggestions.length > 1 ? 's' : ''} already exist at this path —
                  click one to use it as a starting point
                </span>
              </div>
              <ul className="divide-y divide-amber-100">
                {suggestions.map(s => (
                  <li key={s.template.id} className="flex items-center justify-between px-3 py-2">
                    <div className="text-xs">
                      <span className="font-semibold">{s.template.name}</span>
                      <span className="ml-2 text-gray-500">
                        {s.template.hierarchy?.leafKind && (
                          <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 mr-1">
                            {s.template.hierarchy.leafKind}
                          </span>
                        )}
                        {s.template.hierarchy?.params?.kw && <span>{s.template.hierarchy.params.kw} kW · </span>}
                        {s.template.hierarchy?.params?.currentA && <span>{s.template.hierarchy.params.currentA} A · </span>}
                        <span>path {s.template.hierarchy?.path?.join(' / ')}</span>
                      </span>
                    </div>
                    <button
                      onClick={() => {
                        if (!name.trim()) {
                          // Default the name to "<source> copy"
                          setName(`${s.template.name} copy`);
                        }
                        handleCreate(s.template.id);
                      }}
                      className="px-3 py-1 text-xs bg-amber-600 text-white rounded hover:bg-amber-700"
                      disabled={candidateLeafKinds.length > 0 && !leafKind}
                      title={candidateLeafKinds.length === 0 || leafKind ? 'Clone this template into a new one' : 'Pick an equipment kind first'}
                    >
                      Use as base
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Step — Mechanical. Below the path, because it is the path that
              decides which basket the cell falls in and these answers only
              adjust it; above the name, because it is part of what the
              template is rather than what it is called. */}
          {structuralPathComplete && (
            <div>
              <StepHeader
                n={stepNumber('mechanical')}
                label="Mechanical"
                active={activeStep === 'mechanical'}
                done={Object.keys(mechanical).length > 0}
              />
              <div className="mt-2 rounded border border-gray-200 p-3">
                <MechanicalQuestions
                  tier={tier}
                  /* A pasted template has columns to read; a brand-new one
                     has none yet, and the panel says so rather than
                     reporting every fact as absent. */
                  template={startFrom ?? undefined}
                  value={mechanical}
                  onChange={setMechanical}
                  framed={false}
                />
                <p className="mt-2 text-[10px] text-gray-400 italic">
                  Optional — nothing here has to be answered now, and all of it
                  can be changed later from the template's own menu.
                </p>
              </div>
            </div>
          )}

          {/* Simorgh Draw — either way the equipment draws; this only gates
              whether the extra per-equipment questions (separate, later)
              get asked for whatever gets built on this template. */}
          <div>
            <StepHeader
              n={stepNumber('simorghDraw')}
              label="Use Simorgh Draw?"
              /* Never the active step: it is answered from the start and
                 nothing waits on it, so it is shown done and the cursor
                 moves past it. */
              done
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <Chip value="Yes" selected={useSimorghDraw} onClick={() => setUseSimorghDraw(true)} />
              <Chip value="No" selected={!useSimorghDraw} onClick={() => setUseSimorghDraw(false)} />
            </div>
            <p className="mt-1 text-[11px] text-gray-500">
              Answered Yes already — change it if this template's equipment is not drawn here.
              Nothing waits on it.
            </p>
          </div>

          {/* Step — Name + create */}
          <div>
            <StepHeader n={stepNumber('name')} label="Name" active={activeStep === 'name'} done={!!name.trim()} />
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Template name…"
              className="mt-2 w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t bg-gray-50 flex items-center justify-end gap-2">
          {!canCreate && (
            <p className="me-auto text-[12px] text-amber-700">{missing}</p>
          )}
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-white"
          >
            Cancel
          </button>
          <button
            onClick={() => handleCreate()}
            disabled={!canCreate}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
            title={canCreate
              ? (pasteMode === 'edit'
                  ? 'Keep these changes on this template'
                  : startFrom
                    ? (pasteMode === 'move' ? 'File this template here' : 'Paste a copy of it here')
                    : 'Create a fresh template at this path')
              : missing}
          >
            {pasteMode === 'edit'
              ? 'Save changes'
              : startFrom
                ? (pasteMode === 'move' ? 'Move here' : 'Paste a copy here')
                : 'Create empty template'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default HierarchicalTemplateWizard;
