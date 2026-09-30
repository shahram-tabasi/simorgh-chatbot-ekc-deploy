// src/components/TemplateCreation/TemplatesOverview.tsx
//
// Every template of the project in one table, in a browser tab of its own.
//
// Opened from the icon on Create Template's template tree. One row per
// template — its name, its group, its section — and one column per equipment
// slot (CB ORDER, ACCESSORY, …) holding the parts on it, written the way the
// Device Selection "Show Template Items" columns write them. It is for looking
// across templates: finding the ones that use a breaker, seeing what sets two
// near-identical templates apart. Nothing here edits a template.
//
// It stays current by itself. The tab the project is open in announces every
// change to the templates on a BroadcastChannel (see ProjectContext), so an
// edit there is on this table at once. With that tab closed, the project is
// read from the server instead, every fifteen seconds.

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TemplateItem, ProjectData } from '../../types/project';
import {
  LV_TEMPLATE_PROPERTIES, MV_TEMPLATE_PROPERTIES, HV_TEMPLATE_PROPERTIES,
  templateParts, partsCellText,
} from '../../utils/tierEquipmentMatrix';
import { templateMeta } from '../../utils/templateMeta';
import { TIERS, TIER_PILL, type Tier, withAllTiers } from '../../utils/tiers';

export const TEMPLATES_CHANNEL = 'simorgh-templates';

export interface TemplatesMessage {
  type: 'templates';
  projectId: string;
  projectName: string;
  templates: ProjectData['templates'];
}

const API = `${(import.meta as { env?: Record<string, string> }).env?.VITE_API_URL || ''}/api`;

// Fixed widths, so a frozen column knows exactly where it sits.
const W = { num: 44, pick: 36, name: 260, tier: 56, section: 170, prop: 180 };

interface Col { key: string; header: string; width: number; value: (t: TemplateItem) => string }

export const TemplatesOverview: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [templates, setTemplates] = useState<ProjectData['templates'] | null>(null);
  const [projectName, setProjectName] = useState('');
  const [source, setSource] = useState<{ kind: 'live' | 'server'; at: Date } | null>(null);
  const lastLive = useRef(0);

  // ── Staying current ─────────────────────────────────────────────────────
  useEffect(() => {
    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(TEMPLATES_CHANNEL);
      channel.onmessage = e => {
        const m = e.data as TemplatesMessage;
        if (m?.type !== 'templates' || m.projectId !== projectId) return;
        lastLive.current = Date.now();
        setTemplates(m.templates);
        setProjectName(m.projectName);
        setSource({ kind: 'live', at: new Date() });
      };
      // Ask the open project for what it has now.
      channel.postMessage({ type: 'hello', projectId });
    }
    const fromServer = async () => {
      if (Date.now() - lastLive.current < 20_000) return;
      if (!/^[0-9a-f]{24}$/i.test(projectId)) return;
      try {
        const r = await fetch(`${API}/projects/${projectId}`);
        if (!r.ok) return;
        const p = await r.json();
        if (Date.now() - lastLive.current < 20_000) return;
        setTemplates(p.templates);
        setProjectName(p.projectName ?? '');
        setSource({ kind: 'server', at: new Date() });
      } catch { /* tried again in a moment */ }
    };
    const first = setTimeout(fromServer, 1500);
    const every = setInterval(fromServer, 15_000);
    return () => { channel?.close(); clearTimeout(first); clearInterval(every); };
  }, [projectId]);

  useEffect(() => {
    document.title = `Templates — ${projectName || 'Simorgh'}`;
  }, [projectName]);

  const all: TemplateItem[] = useMemo(() => {
    const t = withAllTiers<TemplateItem>(templates ?? undefined);
    return TIERS.flatMap(tier => t[tier]);
  }, [templates]);

  // ── What is shown ───────────────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const [tierFilter, setTierFilter] = useState<Tier | ''>('');
  const [colFilters, setColFilters] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [comparing, setComparing] = useState(false);
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [freezeCols, setFreezeCols] = useState(3);
  const [freezeHeader, setFreezeHeader] = useState(true);
  const [freezeRows, setFreezeRows] = useState(0);

  const partsOf = useMemo(() => {
    const m = new Map<string, Record<string, any[]>>();
    for (const t of all) m.set(t.id, templateParts(t));
    return m;
  }, [all]);
  const cell = (t: TemplateItem, prop: string) => partsCellText(partsOf.get(t.id)?.[prop] ?? []);

  // The slots of the groups in view, in their own order, then any other slot
  // a template uses (a renamed spare, an older column).
  const propColumns = useMemo(() => {
    const tiers = new Set(all.filter(t => !tierFilter || t.type === tierFilter).map(t => t.type));
    const ordered: string[] = [];
    const add = (p: string) => { if (!ordered.includes(p)) ordered.push(p); };
    const lvLike = ['LV', 'OTHER'], mvLike = ['MV', 'GIS'];
    if ([...tiers].some(t => lvLike.includes(t))) LV_TEMPLATE_PROPERTIES.forEach(add);
    if ([...tiers].some(t => mvLike.includes(t))) MV_TEMPLATE_PROPERTIES.forEach(add);
    if (tiers.has('HV')) HV_TEMPLATE_PROPERTIES.forEach(add);
    const extra = new Set<string>();
    for (const t of all) {
      if (tierFilter && t.type !== tierFilter) continue;
      for (const p of Object.keys(partsOf.get(t.id) ?? {})) if (!ordered.includes(p)) extra.add(p);
    }
    return [...ordered, ...[...extra].sort()];
  }, [all, tierFilter, partsOf]);

  const baseCols: Col[] = [
    { key: '__name', header: 'Template', width: W.name, value: t => t.name },
    { key: '__tier', header: 'Group', width: W.tier, value: t => t.type },
    { key: '__section', header: 'Section', width: W.section, value: t => templateMeta(t) },
  ];
  const partCols: Col[] = propColumns.map(p => ({ key: p, header: p, width: W.prop, value: t => cell(t, p) }));

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rowsShown = all.filter(t => {
    if (tierFilter && t.type !== tierFilter) return false;
    if (comparing && !picked.has(t.id)) return false;
    const everything = [t.name, t.type, templateMeta(t), ...propColumns.map(p => cell(t, p))].join(' ').toLowerCase();
    if (!words.every(w => everything.includes(w))) return false;
    for (const col of [...baseCols, ...partCols]) {
      const f = (colFilters[col.key] ?? '').trim().toLowerCase();
      if (f && !col.value(t).toLowerCase().includes(f)) return false;
    }
    return true;
  });

  // Compare: a column differs when the templates being compared do not all
  // hold the same thing in it.
  const differs = (col: Col) => {
    if (!comparing || rowsShown.length < 2) return false;
    const first = col.value(rowsShown[0]);
    return rowsShown.some(t => col.value(t) !== first);
  };
  const cols = [...baseCols, ...partCols.filter(c => !(comparing && onlyDiff) || differs(c))];

  // ── Freezing ────────────────────────────────────────────────────────────
  // Columns: #, the pick box, then the columns above; widths are fixed.
  const widths = [W.num, W.pick, ...cols.map(c => c.width)];
  const lefts = widths.map((_, i) => widths.slice(0, i).reduce((a, b) => a + b, 0));
  const headRef = useRef<HTMLTableSectionElement | null>(null);
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);
  const [tops, setTops] = useState<number[]>([]);
  useLayoutEffect(() => {
    const head = headRef.current?.offsetHeight ?? 0;
    const next: number[] = [];
    let acc = head;
    for (let i = 0; i < freezeRows; i++) { next.push(acc); acc += rowRefs.current[i]?.offsetHeight ?? 0; }
    setTops(prev => (prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next));
  });
  const sticky = (col: number, row?: number): React.CSSProperties => {
    const c = col < freezeCols;
    const isHead = row === undefined;
    const r = isHead ? (freezeHeader || freezeRows > 0) : row < freezeRows;
    if (!c && !r) return {};
    return {
      position: 'sticky',
      ...(c ? { left: lefts[col] } : {}),
      ...(r ? { top: isHead ? 0 : tops[row!] ?? 0 } : {}),
      zIndex: isHead ? (c ? 6 : 5) : r ? (c ? 4 : 3) : 2,
    };
  };

  const togglePick = (id: string) => setPicked(prev => {
    const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });

  const th = 'px-2 py-1.5 text-left text-xs font-semibold text-gray-700 border-b border-r border-gray-200 bg-gray-50 align-top';
  const td = 'px-2 py-1.5 text-xs border-b border-r border-gray-100 align-top whitespace-pre-wrap break-words';

  return (
    <div className="h-screen flex flex-col bg-gray-100 text-gray-800">
      <header className="px-4 py-3 bg-white border-b border-gray-200 flex items-center gap-3 flex-wrap shrink-0">
        <div className="min-w-0">
          <h1 className="text-base font-semibold truncate">All templates — {projectName || '…'}</h1>
          <p className="text-[11px] text-gray-500">
            {templates === null
              ? 'Waiting for the project…'
              : source?.kind === 'live'
                ? `Live — follows every change in the project's tab (${source.at.toLocaleTimeString()})`
                : `Read from the server at ${source?.at.toLocaleTimeString() ?? '—'} — read again every 15 s while the project's tab is closed`}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2 flex-wrap text-xs">
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search name or part…"
            className="border border-gray-300 rounded px-2 py-1 w-56 bg-white"
          />
          <select value={tierFilter} onChange={e => setTierFilter(e.target.value as Tier | '')}
            className="border border-gray-300 rounded px-1 py-1 bg-white">
            <option value="">All groups</option>
            {TIERS.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <label className="flex items-center gap-1 border border-gray-300 rounded px-2 py-1 bg-white">
            Freeze
            <input type="number" min={0} max={widths.length} value={freezeCols}
              onChange={e => setFreezeCols(Math.max(0, Math.min(widths.length, Number(e.target.value) || 0)))}
              className="w-12 border border-gray-300 rounded px-1" />
            / {widths.length} cols
          </label>
          <button onClick={() => setFreezeHeader(v => !v)}
            className={`border rounded px-2 py-1 ${freezeHeader ? 'bg-blue-50 border-blue-300 text-blue-800' : 'bg-white border-gray-300'}`}>
            Freeze header
          </button>
          <label className="flex items-center gap-1 border border-gray-300 rounded px-2 py-1 bg-white">
            Freeze
            <input type="number" min={0} max={rowsShown.length} value={freezeRows}
              onChange={e => setFreezeRows(Math.max(0, Math.min(rowsShown.length, Number(e.target.value) || 0)))}
              className="w-12 border border-gray-300 rounded px-1" />
            rows
          </label>
          <button
            disabled={picked.size < 2}
            onClick={() => setComparing(v => !v)}
            title={picked.size < 2 ? 'Tick two or more templates to compare them' : undefined}
            className={`border rounded px-2 py-1 disabled:opacity-40 ${comparing ? 'bg-amber-50 border-amber-300 text-amber-800' : 'bg-white border-gray-300'}`}>
            {comparing ? `Comparing ${picked.size} — show all` : `Compare${picked.size ? ` (${picked.size})` : ''}`}
          </button>
          {comparing && (
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={onlyDiff} onChange={e => setOnlyDiff(e.target.checked)} />
              only differences
            </label>
          )}
          {picked.size > 0 && (
            <button onClick={() => { setPicked(new Set()); setComparing(false); }} className="underline text-gray-600">
              Clear picks
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto overscroll-contain bg-white m-3 border border-gray-200 rounded">
        <table className="border-separate border-spacing-0 text-left" style={{ width: widths.reduce((a, b) => a + b, 0) }}>
          <colgroup>{widths.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
          <thead ref={headRef}>
            <tr>
              <th className={th} style={sticky(0)}>#</th>
              <th className={th} style={sticky(1)} title="Tick to compare">✓</th>
              {cols.map((c, i) => (
                <th key={c.key} className={`${th} ${differs(c) ? 'bg-amber-50' : ''}`} style={sticky(i + 2)}>
                  {c.header}
                </th>
              ))}
            </tr>
            <tr>
              <th className={th} style={sticky(0)} />
              <th className={th} style={sticky(1)} />
              {cols.map((c, i) => (
                <th key={c.key} className={th} style={sticky(i + 2)}>
                  <input
                    value={colFilters[c.key] ?? ''}
                    onChange={e => setColFilters(prev => ({ ...prev, [c.key]: e.target.value }))}
                    placeholder="filter"
                    className="w-full border border-gray-300 rounded px-1 py-0.5 font-normal bg-white"
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowsShown.map((t, r) => (
              <tr key={t.id} ref={el => { rowRefs.current[r] = el; }} className="hover:bg-gray-50">
                <td className={`${td} bg-white text-gray-400`} style={sticky(0, r)}>{r + 1}</td>
                <td className={`${td} bg-white`} style={sticky(1, r)}>
                  <input type="checkbox" checked={picked.has(t.id)} onChange={() => togglePick(t.id)} />
                </td>
                {cols.map((c, i) => {
                  const v = c.value(t);
                  return (
                    <td key={c.key}
                      className={`${td} ${differs(c) ? 'bg-amber-50' : 'bg-white'} ${c.key === '__name' ? 'font-medium' : ''}`}
                      style={sticky(i + 2, r)}>
                      {c.key === '__tier'
                        ? <span className={`px-1 rounded text-[10px] font-semibold ${TIER_PILL[t.type] ?? ''}`}>{v}</span>
                        : v}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {templates !== null && rowsShown.length === 0 && (
          <p className="p-6 text-sm text-gray-500 italic">No template matches.</p>
        )}
      </div>
      <footer className="px-4 pb-2 text-[11px] text-gray-500 shrink-0">
        {rowsShown.length} of {all.length} templates · {cols.length - baseCols.length} equipment columns
      </footer>
    </div>
  );
};
