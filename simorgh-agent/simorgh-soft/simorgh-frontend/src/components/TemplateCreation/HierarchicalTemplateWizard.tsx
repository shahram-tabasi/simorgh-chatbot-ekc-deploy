// Hierarchical Template Wizard — walks the user step-by-step down the
// equipment-classification tree the team uses, and at every step shows
// existing templates that already live at the same path. The user can
// either pick one (creates a clone with a fresh name) or proceed and
// create a brand-new template at the chosen leaf.
//
// LV taxonomy (top → leaf):
//   family    : SIVACON (8PT, S8) | CCS (OFW, marshaling, …)
//   root      : S8 | 8PT   (SIVACON only — the CCS side has no board root)
//   group     : CCS | OFF | OFW | MARSHALING | SWING
//   switch    : (only under OFW) SFD | HFD | FCB1 | FCB2 | FCB3
//   feeder    : (only under FCB*) INCOMING | COUPLING | METERING | RISER | MET&RISER | OUTGOING
//   leafKind  : motor | transformer (FCB outgoing) | lighting (SFD/HFD)
//   params    : kW + currentA
//
// MV taxonomy:
//   feeder    : INCOMING | COUPLING | METERING | RISER | MET&RISER | OUTGOING
//   leafKind  : motor | transformer
//   params    : kW + currentA
//
// The wizard never blocks creation — if a step doesn't apply for the tier
// or branch (e.g. MV has no S8/8PT root), it's skipped. Suggested templates
// are scored by leafKind match + |Δkw| + |Δcurrent|.

import React, { useMemo, useState } from 'react';
import { XIcon, ChevronRightIcon, SparklesIcon, CheckIcon } from 'lucide-react';
import {
  TemplateItem, TemplateHierarchy, TemplateLeafKind,
} from '../../types/project';
import { TEMPLATE_FAMILIES } from '../../utils/templateFamilies';

const LV_ROOTS    = ['S8', '8PT'] as const;
const LV_GROUPS   = ['CCS', 'OFF', 'OFW', 'MARSHALING', 'SWING'] as const;
const LV_SWITCHES = ['SFD', 'HFD', 'FCB1', 'FCB2', 'FCB3'] as const;
const FEEDERS     = ['INCOMING', 'COUPLING', 'METERING', 'RISER', 'MET&RISER', 'OUTGOING'] as const;

// Which leaf kinds are valid for a given (tier, switch, feeder) tuple.
function allowedLeafKinds(
  tier: 'LV' | 'MV' | 'HV',
  switchNode: string | null,
  feeder: string | null,
): TemplateLeafKind[] {
  if (tier === 'MV') {
    return feeder === 'OUTGOING' ? ['motor', 'transformer'] : ['other'];
  }
  if (tier === 'LV') {
    if (switchNode && switchNode.startsWith('FCB')) {
      return feeder === 'OUTGOING' ? ['motor', 'transformer'] : ['other'];
    }
    if (switchNode === 'SFD' || switchNode === 'HFD') {
      return ['motor', 'lighting'];
    }
    return ['other'];
  }
  return ['other'];
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
  tier: 'LV' | 'MV' | 'HV';
  /** All existing templates for this tier (used for suggestions). */
  existing: TemplateItem[];
  onCancel: () => void;
  /** `copyFromId` populated when the user picked an existing template
   *  as the starting point. */
  onSubmit: (args: {
    name: string;
    hierarchy: TemplateHierarchy;
    copyFromId?: string;
  }) => void;
}

export const HierarchicalTemplateWizard: React.FC<Props> = ({
  tier, existing, onCancel, onSubmit,
}) => {
  // Path nodes — present iff the tier exposes that step.
  // Which side of the works this belongs to. SIVACON boards are filed under a
  // root (S8, 8PT); the CCS side is not, so that step is skipped for it and
  // the path simply starts at the group — which is what CCS paths already
  // look like where they exist.
  const [family,  setFamily]  = useState<string | null>(null);   // SIVACON | CCS (LV only)
  const [root,    setRoot]    = useState<string | null>(null);   // S8 | 8PT  (LV only)
  const [group,   setGroup]   = useState<string | null>(null);   // CCS | OFF | … (LV only)
  const [switch_, setSwitch]  = useState<string | null>(null);   // SFD | HFD | FCBn  (LV/OFW only)
  const [feeder,  setFeeder]  = useState<string | null>(null);   // INCOMING | …  (MV + LV/FCB*)
  const [leafKind, setLeafKind] = useState<TemplateLeafKind | null>(null);
  const [kw, setKw] = useState('');
  const [currentA, setCurrentA] = useState('');
  const [name, setName] = useState('');

  // Build the path array as the user descends.
  const path = useMemo(() => {
    const p: string[] = [];
    if (tier === 'LV') {
      if (root)   p.push(root);
      if (group)  p.push(group);
      if (switch_)p.push(switch_);
      if (feeder) p.push(feeder);
    } else if (tier === 'MV') {
      if (feeder) p.push(feeder);
    }
    return p;
  }, [tier, root, group, switch_, feeder]);

  // Which step are we on? The first step missing a value is the active one.
  const activeStep: 'family' | 'root' | 'group' | 'switch' | 'feeder' | 'kind' | 'params' | 'name' = (() => {
    if (tier === 'LV') {
      if (!family) return 'family';
      if (family === 'SIVACON' && !root) return 'root';
      if (!group)  return 'group';
      if (group === 'OFW' && !switch_) return 'switch';
      // feeders only apply under FCBn switches and (per spec) FCB1/2/3 chain
      if (switch_ && switch_.startsWith('FCB') && !feeder) return 'feeder';
    }
    if (tier === 'MV' && !feeder) return 'feeder';
    if (!leafKind) return 'kind';
    if (!kw && !currentA) return 'params';
    return 'name';
  })();

  const candidateLeafKinds = allowedLeafKinds(tier, switch_, feeder);

  // Score & rank suggestions at the current path so the user sees real
  // proposals refine as they go deeper.
  const suggestions = useMemo(() => {
    if (path.length === 0) return [];
    const draft: TemplateHierarchy = {
      path, leafKind: leafKind || undefined,
      params: { kw: kw || undefined, currentA: currentA || undefined },
    };
    return existing
      .filter(t => {
        const p = t.hierarchy?.path;
        if (!p) return false;
        // Match path PREFIX so partial matches still show up as you drill in.
        if (p.length < path.length) return false;
        return path.every((step, i) => String(p[i]).toLowerCase() === step.toLowerCase());
      })
      .map(t => ({ template: t, score: scoreSimilarity(t, draft) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }, [existing, path, leafKind, kw, currentA]);

  // Step UI helpers ───────────────────────────────────────────────────────
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
    setRoot(null); setGroup(null); setSwitch(null); setFeeder(null); setLeafKind(null);
  };
  const pickRoot = (r: string) => { setRoot(r); setGroup(null); setSwitch(null); setFeeder(null); setLeafKind(null); };
  const pickGroup = (g: string) => { setGroup(g); setSwitch(null); setFeeder(null); setLeafKind(null); };
  const pickSwitch = (s: string) => { setSwitch(s); setFeeder(null); setLeafKind(null); };
  const pickFeeder = (f: string) => { setFeeder(f); setLeafKind(null); };

  const canCreate = name.trim().length > 0 && (
    tier === 'MV'
      ? !!feeder
      // SIVACON is filed under its board root; the CCS side starts at the group.
      : (!!group && (family !== 'SIVACON' || !!root))
  );

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
      copyFromId,
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
            <h2 className="text-base font-semibold">New {tier} Template</h2>
          </div>
          <button onClick={onCancel} className="p-1 rounded hover:bg-white/20">
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        {/* Breadcrumb */}
        <div className="px-5 py-2 border-b bg-gray-50">
          <PathBreadcrumb />
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Step 1 — System (LV only) */}
          {tier === 'LV' && (
            <div>
              <StepHeader n={1} label="System" active={activeStep === 'family'} done={!!family} />
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

          {/* Step 2 — Root (SIVACON boards only) */}
          {tier === 'LV' && family === 'SIVACON' && (
            <div>
              <StepHeader n={2} label="Root" active={activeStep === 'root'} done={!!root} />
              <div className="mt-2 flex flex-wrap gap-2">
                {LV_ROOTS.map(r => (
                  <Chip key={r} value={r} selected={root === r} onClick={() => pickRoot(r)} />
                ))}
              </div>
            </div>
          )}

          {/* Step 3 — Group (LV only) */}
          {tier === 'LV' && (family === 'CCS' || root) && (
            <div>
              <StepHeader n={3} label="Group" active={activeStep === 'group'} done={!!group} />
              <div className="mt-2 flex flex-wrap gap-2">
                {LV_GROUPS.map(g => (
                  <Chip key={g} value={g} selected={group === g} onClick={() => pickGroup(g)} />
                ))}
              </div>
            </div>
          )}

          {/* Step 4 — Switch (LV/OFW only) */}
          {tier === 'LV' && group === 'OFW' && (
            <div>
              <StepHeader n={4} label="Switch" active={activeStep === 'switch'} done={!!switch_} />
              <div className="mt-2 flex flex-wrap gap-2">
                {LV_SWITCHES.map(s => (
                  <Chip key={s} value={s} selected={switch_ === s} onClick={() => pickSwitch(s)} />
                ))}
              </div>
            </div>
          )}

          {/* Step 5 — Feeder (MV always, LV when under FCBn) */}
          {(tier === 'MV' || (tier === 'LV' && switch_ && switch_.startsWith('FCB'))) && (
            <div>
              <StepHeader n={tier === 'MV' ? 1 : 5} label="Feeder" active={activeStep === 'feeder'} done={!!feeder} />
              <div className="mt-2 flex flex-wrap gap-2">
                {FEEDERS.map(f => (
                  <Chip key={f} value={f} selected={feeder === f} onClick={() => pickFeeder(f)} />
                ))}
              </div>
            </div>
          )}

          {/* Step 6 — Leaf kind */}
          {path.length > 0 && (
            <div>
              <StepHeader n={6} label="Equipment kind" active={activeStep === 'kind'} done={!!leafKind} />
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

          {/* Step 7 — Parameters */}
          {leafKind && (
            <div>
              <StepHeader n={7} label="Parameters" active={activeStep === 'params'} done={!!(kw || currentA)} />
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

          {/* Step 7 — Suggestions (live as path narrows) */}
          {suggestions.length > 0 && (
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
                      disabled={!leafKind}
                      title={leafKind ? 'Clone this template into a new one' : 'Pick an equipment kind first'}
                    >
                      Use as base
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Step 8 — Name + create */}
          <div>
            <StepHeader n={8} label="Name" active={activeStep === 'name'} done={!!name.trim()} />
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
            title={canCreate ? 'Create a fresh template at this path' : 'Pick a path and enter a name first'}
          >
            Create empty template
          </button>
        </div>
      </div>
    </div>
  );
};

export default HierarchicalTemplateWizard;
