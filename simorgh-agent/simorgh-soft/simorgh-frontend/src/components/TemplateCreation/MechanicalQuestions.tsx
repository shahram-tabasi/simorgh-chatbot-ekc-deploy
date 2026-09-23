import React from 'react';
import { CheckIcon, InfoIcon, RotateCcwIcon } from 'lucide-react';
import { TemplateItem, TemplateMechanical } from '../../types/project';
import { templateFacts, Fact } from '../../utils/mechanical/template';
import { type Tier } from '../../utils/tiers';

// The mechanical questions a template is asked — and the ones it is not.
//
// The estimate sheets need to know, about every cell: has it a breaker and
// which one, has it a VT, has it a CT, has it a cable or a bus earth switch,
// and what magnet label it carries. Five of those seven are already written
// down in the template's own columns — an empty CB ORDER row says the cell
// has no breaker as plainly as any answer would — so this panel *shows* them
// and names the column each was read from, rather than asking again and then
// having to decide which of two answers to believe.
//
// Only the earth switches and the magnet label are genuinely unwritten, and
// only those are asked. When the office's labelling is standardised those
// become readable too, at which point the question turns into an override —
// which is why every read fact already carries one.

interface Props {
  tier: Tier;
  /**
   * The template the facts are read from.
   *
   * Left out in the creation wizard, where the template does not exist yet
   * and has no columns to read: there the read facts are shown as pending
   * and only the answered ones are on offer.
   */
  template?: TemplateItem;
  value: TemplateMechanical;
  onChange: (next: TemplateMechanical) => void;
  /** Off in the wizard, where the panel already sits inside a step. */
  framed?: boolean;
}

/** What these answers are for, which is not the same on every tier. */
const PURPOSE: Record<Tier, string> = {
  LV: 'Kept for reference. LV mechanical items are not built from these answers '
    + 'yet — they are saved with the template and can be changed at any time, '
    + 'ready for when they are.',
  MV: 'Projects started here build their mechanical items from these answers.',
  HV: 'Kept for reference until the HV sheets are in.',
  GIS: 'Kept for reference until the GIS sheets are in.',
  OTHER: 'Kept for reference — there is no estimate sheet for this group.',
};

const Pill: React.FC<{
  on: boolean; label: string; onClick: () => void; tone?: 'blue' | 'gray';
}> = ({ on, label, onClick, tone = 'blue' }) => (
  <button
    type="button"
    onClick={onClick}
    className={`px-2.5 py-1 rounded-full border text-xs transition-colors ${
      on
        ? tone === 'blue'
          ? 'bg-blue-600 border-blue-600 text-white'
          : 'bg-gray-600 border-gray-600 text-white'
        : 'bg-white border-gray-300 text-gray-600 hover:border-blue-400'
    }`}
  >
    {on && <CheckIcon className="w-3 h-3 inline mr-1 -mt-0.5" />}{label}
  </button>
);

/**
 * One fact read from a column, with the column named and a way to overrule it.
 *
 * "Auto" is the column's own reading. Yes and No are somebody saying
 * otherwise — for the cell whose breaker is listed where the columns do not
 * look, and for the day a column means something else.
 */
const ReadFact: React.FC<{
  label: string;
  fact: Fact<boolean>;
  override: boolean | undefined;
  onOverride: (next: boolean | undefined) => void;
  /** Absent while the template has no columns to read — the wizard. */
  pending?: boolean;
  children?: React.ReactNode;
}> = ({ label, fact, override, onOverride, pending, children }) => (
  <div className="py-2 border-b border-gray-100 last:border-b-0">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs font-medium text-gray-700">{label}</p>
        <p className={`text-[11px] ${fact.overridden ? 'text-amber-700' : 'text-gray-500'}`}>
          {pending && !fact.overridden
            ? 'read from the template once its parts are in'
            : <>
                <span className={fact.value ? 'text-emerald-700 font-medium' : 'text-gray-600 font-medium'}>
                  {fact.value ? 'Yes' : 'No'}
                </span>
                {' — '}{fact.from}
              </>}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Pill on={override === undefined} label="Auto" tone="gray"
          onClick={() => onOverride(undefined)} />
        <Pill on={override === true} label="Yes" onClick={() => onOverride(true)} />
        <Pill on={override === false} label="No" onClick={() => onOverride(false)} />
      </div>
    </div>
    {children}
  </div>
);

export const MechanicalQuestions: React.FC<Props> = ({
  tier, template, value, onChange, framed = true,
}) => {
  // The facts as they stand with the answers being edited, so an override
  // shows its effect while it is being made.
  const facts = templateFacts(
    template ? { ...template, mechanical: value } : undefined, tier);
  const pending = !template;

  const set = (patch: Partial<TemplateMechanical>) => onChange({ ...value, ...patch });
  // An override is cleared by dropping the key, not by writing undefined into
  // it — `templateFacts` tests for the key's absence to mean "the column decides".
  const clear = (key: keyof TemplateMechanical) => {
    const next = { ...value };
    delete next[key];
    onChange(next);
  };
  const override = (key: 'hasBreaker' | 'hasVt' | 'hasCt') =>
    (next: boolean | undefined) =>
      (next === undefined ? clear(key) : set({ [key]: next } as Partial<TemplateMechanical>));

  const body = (
    <div className="space-y-3">
      <p className="flex items-start gap-1.5 text-[11px] text-gray-500">
        <InfoIcon className="w-3.5 h-3.5 shrink-0 mt-px text-gray-400" />
        <span>{PURPOSE[tier]}</span>
      </p>

      {/* Read from the template's own columns. */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          From the template
        </p>
        <div className="mt-1">
          <ReadFact
            label="Circuit breaker"
            fact={facts.hasBreaker}
            override={value.hasBreaker}
            onOverride={override('hasBreaker')}
            pending={pending}
          >
            {(facts.hasBreaker.value || value.hasBreaker === true) && (
              <div className="mt-1.5 flex items-center gap-1.5">
                <input
                  type="text"
                  value={value.breakerType ?? facts.breakerType.value}
                  onChange={e => set({ breakerType: e.target.value })}
                  placeholder="Breaker order number, e.g. 3AH5"
                  className="flex-1 min-w-0 border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-400"
                />
                {value.breakerType !== undefined && (
                  <button
                    type="button"
                    onClick={() => clear('breakerType')}
                    title="Back to the order number on the part in the column"
                    className="p-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-100"
                  >
                    <RotateCcwIcon className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}
          </ReadFact>
          <ReadFact
            label="Voltage transformer (VT / PT)"
            fact={facts.hasVt} override={value.hasVt}
            onOverride={override('hasVt')} pending={pending}
          />
          <ReadFact
            label="Current transformer (CT)"
            fact={facts.hasCt} override={value.hasCt}
            onOverride={override('hasCt')} pending={pending}
          />
        </div>
      </div>

      {/* Asked, because no column states them. */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          Asked here
        </p>
        <div className="mt-1.5 space-y-2">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={value.cableEarthSwitch === true}
              onChange={e => set({ cableEarthSwitch: e.target.checked })}
              className="mt-0.5"
            />
            <span>
              <span className="block text-xs text-gray-700">Cable earth switch (QC1)</span>
              <span className="block text-[11px] text-gray-500">
                Adds the cable earth switch basket to the cell.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={value.busEarthSwitch === true}
              onChange={e => set({ busEarthSwitch: e.target.checked })}
              className="mt-0.5"
            />
            <span>
              <span className="block text-xs text-gray-700">Bus earth switch (QC2)</span>
              <span className="block text-[11px] text-gray-500">
                Adds the bus earth truck and switch baskets.
              </span>
            </span>
          </label>
          <label className="block">
            <span className="block text-xs text-gray-700">Magnet label</span>
            {/* Typed against a list rather than picked from one: the labels
                are the office's own and there will be more of them, and a
                label this build has not heard of must still be enterable. */}
            <input
              type="text"
              list="simorgh-magnet-labels"
              value={value.magnetLabel ?? ''}
              onChange={e => set({ magnetLabel: e.target.value.toUpperCase() })}
              placeholder="MB3, MB4 — or leave empty for none"
              className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-xs focus:outline-none focus:border-blue-400"
            />
            <datalist id="simorgh-magnet-labels">
              <option value="MB3" />
              <option value="MB4" />
            </datalist>
            <span className="block mt-1 text-[11px] text-gray-500">
              Left empty, the feeder's own SFD/HFD stands in — which is where
              this office writes it today.
            </span>
          </label>
        </div>
      </div>
    </div>
  );

  if (!framed) return body;
  return (
    <div className="border border-gray-200 rounded-lg bg-white">
      <div className="px-3 py-2 border-b bg-gray-50">
        <p className="text-sm font-medium text-gray-800">Mechanical</p>
        <p className="text-[11px] text-gray-500">
          What the estimate sheets ask about this cell.
        </p>
      </div>
      <div className="p-3">{body}</div>
    </div>
  );
};

export default MechanicalQuestions;
