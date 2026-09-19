// src/components/PLC/PlcProjectTree.tsx
//
// The tree on the left — the controller and everything in it.
//
// It is the same shape every PLC tool uses, and the shape is not arbitrary:
// **Program blocks**, **PLC tags**, **PLC data types**. Those are the three
// kinds of thing a controller holds, and an engineer opening this page already
// knows where to look because they have looked there in four other tools.
// Inventing a better arrangement would cost that and buy nothing.
//
// Blocks are grouped by kind and sorted by number inside it, which is the
// order they are listed in on the controller and the order a listing prints
// them in. Sorting by name instead reads nicely and means the cyclic
// interrupt is filed under C, miles from OB1.
//
// Everything a block can have done to it is in the right-click menu, and the
// dangerous ones say what they will take with them before they do it — a
// function block deleted while three instance data blocks point at it leaves
// three data blocks that are the memory of nothing.

import React, { useMemo, useState } from 'react';
import {
  ChevronDownIcon, ChevronRightIcon, CpuIcon, FolderIcon, PlusIcon, TableIcon,
  BoxIcon, FileCodeIcon, DatabaseIcon, LayersIcon, TrashIcon, CopyIcon, PencilIcon,
  DownloadIcon, TagsIcon, SearchIcon, AlertCircleIcon,
} from 'lucide-react';
import { MenuBox } from '../shared/MenuBox';
import {
  PlcBlock, PlcBlockKind, PlcProject, absoluteName, freeName, newId, nextNumber,
} from '../../utils/plc/model';
import { Problem } from '../../utils/plc/analyze';

export type TreeSelection =
  | { what: 'block'; id: string }
  | { what: 'tags'; tableId: string | null }
  | { what: 'device' };

interface Props {
  project: PlcProject;
  selection: TreeSelection;
  problems: Problem[];
  readOnly?: boolean;
  onSelect: (s: TreeSelection) => void;
  onAddBlock: (kind: PlcBlockKind) => void;
  onChange: (next: PlcProject) => void;
  onExportBlock: (block: PlcBlock) => void;
}

const KIND_ORDER: PlcBlockKind[] = ['OB', 'FB', 'FC', 'DB', 'UDT'];

const KIND_LABEL: Record<PlcBlockKind, string> = {
  OB: 'Organization blocks',
  FB: 'Function blocks',
  FC: 'Functions',
  DB: 'Data blocks',
  UDT: 'PLC data types',
};

function kindIcon(kind: PlcBlockKind, className: string): React.ReactNode {
  switch (kind) {
    case 'OB': return <CpuIcon className={className} />;
    case 'FB': return <BoxIcon className={className} />;
    case 'FC': return <FileCodeIcon className={className} />;
    case 'DB': return <DatabaseIcon className={className} />;
    case 'UDT': return <LayersIcon className={className} />;
  }
}

export const PlcProjectTree: React.FC<Props> = ({
  project, selection, problems, readOnly, onSelect, onAddBlock, onChange, onExportBlock,
}) => {
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(['device', 'blocks', 'tags', 'types', 'OB', 'FB', 'FC', 'DB']));
  const [menu, setMenu] = useState<{ x: number; y: number; blockId?: string; folder?: PlcBlockKind } | null>(null);
  const [filter, setFilter] = useState('');

  const toggle = (id: string) => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  /** How many errors and warnings each block carries, for the badge. */
  const trouble = useMemo(() => {
    const by = new Map<string, { errors: number; warnings: number }>();
    for (const p of problems) {
      if (!p.blockId) continue;
      const at = by.get(p.blockId) ?? { errors: 0, warnings: 0 };
      if (p.severity === 'error') at.errors += 1;
      else if (p.severity === 'warning') at.warnings += 1;
      by.set(p.blockId, at);
    }
    return by;
  }, [problems]);

  const matches = (b: PlcBlock) => !filter.trim()
    || `${b.name} ${absoluteName(b)} ${b.comment ?? ''}`.toLowerCase()
      .includes(filter.trim().toLowerCase());

  const byKind = useMemo(() => {
    const out = new Map<PlcBlockKind, PlcBlock[]>();
    for (const kind of KIND_ORDER) {
      out.set(kind, project.blocks
        .filter(b => b.kind === kind && matches(b))
        .sort((a, b) => (a.number ?? 9999) - (b.number ?? 9999) || a.name.localeCompare(b.name)));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.blocks, filter]);

  // ── Things done to a block ────────────────────────────────────────────────

  const rename = (block: PlcBlock) => {
    const next = window.prompt('What should this block be called?', block.name);
    if (!next?.trim() || next.trim() === block.name) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(next.trim())) {
      window.alert('A block name is letters, digits and underscores, starting with a letter.');
      return;
    }
    if (project.blocks.some(b => b.id !== block.id && b.name.toLowerCase() === next.trim().toLowerCase())) {
      window.alert('Something in this project is already called that.');
      return;
    }
    // Every call of it, renamed with it. A rename that leaves ten calls
    // pointing at a name nothing answers to is a rename that broke the
    // program, and finding those ten by hand is the afternoon nobody has.
    const from = new RegExp(`"${block.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g');
    onChange({
      ...project,
      blocks: project.blocks.map(b => {
        if (b.id === block.id) return { ...b, name: next.trim(), changedAt: new Date().toISOString() };
        const code = b.code?.replace(from, `"${next.trim()}"`);
        const instanceOf = b.instanceOf === block.id ? b.instanceOf : b.instanceOf;
        const networks = b.networks?.map(n => ({
          ...n,
          rung: {
            ...n.rung,
            groups: n.rung.groups.map(g => ({
              branches: g.branches.map(br => ({
                elements: br.elements.map(el => (el.k === 'block' && el.type === block.name
                  ? { ...el, type: next.trim() } : el)),
              })),
            })),
          },
        }));
        return code === b.code && networks === b.networks ? b : { ...b, code, networks, instanceOf };
      }),
    });
  };

  const duplicate = (block: PlcBlock) => {
    const copy: PlcBlock = {
      ...JSON.parse(JSON.stringify(block)),
      id: newId('b'),
      name: freeName(project, `${block.name}_copy`),
      number: block.kind === 'UDT' ? undefined : nextNumber(project, block.kind),
      createdAt: new Date().toISOString(),
      changedAt: new Date().toISOString(),
    };
    onChange({ ...project, blocks: [...project.blocks, copy] });
    onSelect({ what: 'block', id: copy.id });
  };

  const remove = (block: PlcBlock) => {
    const instances = project.blocks.filter(b => b.instanceOf === block.id);
    const callers = project.blocks.filter(b =>
      b.id !== block.id
      && ((b.code ?? '').includes(`"${block.name}"`)
        || (b.networks ?? []).some(n => n.rung.groups.some(g => g.branches.some(br =>
          br.elements.some(el => el.k === 'block' && el.type === block.name))))));

    const warnings: string[] = [];
    if (instances.length > 0) {
      warnings.push(`${instances.length} instance data block${instances.length > 1 ? 's' : ''} `
        + `(${instances.map(b => b.name).join(', ')}) would be the memory of nothing.`);
    }
    if (callers.length > 0) {
      warnings.push(`${callers.length} block${callers.length > 1 ? 's' : ''} `
        + `(${callers.map(b => b.name).join(', ')}) call it by name and would stop compiling.`);
    }

    const ok = window.confirm(
      `Delete ${block.kind} "${block.name}"?\n\n`
      + (warnings.length > 0 ? `${warnings.join('\n')}\n\n` : '')
      + 'This cannot be undone from here.',
    );
    if (!ok) return;
    onChange({ ...project, blocks: project.blocks.filter(b => b.id !== block.id) });
    if (selection.what === 'block' && selection.id === block.id) {
      const first = project.blocks.find(b => b.id !== block.id);
      onSelect(first ? { what: 'block', id: first.id } : { what: 'device' });
    }
  };

  // ── Rows ──────────────────────────────────────────────────────────────────

  const Folder: React.FC<{
    id: string; label: string; icon: React.ReactNode; count?: number;
    depth: number; onContextMenu?: (e: React.MouseEvent) => void; children?: React.ReactNode;
  }> = ({ id, label, icon, count, depth, onContextMenu, children }) => (
    <>
      <button
        className="w-full flex items-center gap-1.5 py-1 pe-2 text-left hover:bg-blue-50"
        style={{ paddingInlineStart: depth * 14 + 4 }}
        onClick={() => toggle(id)}
        onContextMenu={onContextMenu}
      >
        {open.has(id)
          ? <ChevronDownIcon className="w-3.5 h-3.5 text-gray-400 shrink-0" />
          : <ChevronRightIcon className="w-3.5 h-3.5 text-gray-400 shrink-0" />}
        {icon}
        <span className="truncate">{label}</span>
        {count !== undefined && <span className="ms-auto text-[10px] text-gray-400">{count}</span>}
      </button>
      {open.has(id) && children}
    </>
  );

  return (
    <div className="h-full flex flex-col text-[12px] bg-white" onClick={() => menu && setMenu(null)}>
      <div className="p-2 border-b shrink-0">
        <div className="relative">
          <SearchIcon className="w-3.5 h-3.5 absolute start-2 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Search in project"
            className="w-full ps-7 pe-2 py-1.5 rounded border border-gray-300 focus:border-blue-400 focus:outline-none"
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto py-1">
        <Folder
          id="device"
          depth={0}
          icon={<CpuIcon className="w-4 h-4 text-emerald-600 shrink-0" />}
          label={`${project.device.name} [${project.device.cpu}]`}
        >
          {/* Program blocks */}
          <Folder
            id="blocks"
            depth={1}
            icon={<FolderIcon className="w-4 h-4 text-amber-500 shrink-0" />}
            label="Program blocks"
            count={project.blocks.filter(b => b.kind !== 'UDT').length}
            onContextMenu={e => {
              if (readOnly) return;
              e.preventDefault(); e.stopPropagation();
              setMenu({ x: e.clientX, y: e.clientY, folder: 'FB' });
            }}
          >
            {!readOnly && (
              <button
                className="w-full flex items-center gap-1.5 py-1 pe-2 text-left text-blue-700 hover:bg-blue-50"
                style={{ paddingInlineStart: 2 * 14 + 4 }}
                onClick={() => onAddBlock('FB')}
              >
                <PlusIcon className="w-3.5 h-3.5 shrink-0" />
                Add new block
              </button>
            )}

            {KIND_ORDER.filter(k => k !== 'UDT').map(kind => {
              const blocks = byKind.get(kind) ?? [];
              if (blocks.length === 0) return null;
              return (
                <Folder
                  key={kind}
                  id={kind}
                  depth={2}
                  icon={kindIcon(kind, 'w-3.5 h-3.5 text-gray-400 shrink-0')}
                  label={KIND_LABEL[kind]}
                  count={blocks.length}
                  onContextMenu={e => {
                    if (readOnly) return;
                    e.preventDefault(); e.stopPropagation();
                    setMenu({ x: e.clientX, y: e.clientY, folder: kind });
                  }}
                >
                  {blocks.map(b => {
                    const bad = trouble.get(b.id);
                    const selected = selection.what === 'block' && selection.id === b.id;
                    return (
                      <button
                        key={b.id}
                        className={`w-full flex items-center gap-1.5 py-1 pe-2 text-left
                          ${selected ? 'bg-blue-100 font-semibold' : 'hover:bg-blue-50'}`}
                        style={{ paddingInlineStart: 3 * 14 + 4 }}
                        onClick={() => onSelect({ what: 'block', id: b.id })}
                        onContextMenu={e => {
                          e.preventDefault(); e.stopPropagation();
                          onSelect({ what: 'block', id: b.id });
                          setMenu({ x: e.clientX, y: e.clientY, blockId: b.id });
                        }}
                        title={b.comment}
                      >
                        {kindIcon(b.kind, 'w-3.5 h-3.5 shrink-0 text-slate-500')}
                        <span className="truncate">{b.name}</span>
                        <span className="text-[10px] text-gray-400 shrink-0">
                          [{absoluteName(b)}]
                        </span>
                        {bad && (bad.errors > 0 || bad.warnings > 0) && (
                          <span
                            className={`ms-auto shrink-0 inline-flex items-center gap-0.5 text-[10px]
                              ${bad.errors > 0 ? 'text-red-600' : 'text-amber-600'}`}
                            title={`${bad.errors} error(s), ${bad.warnings} warning(s)`}
                          >
                            <AlertCircleIcon className="w-3 h-3" />
                            {bad.errors > 0 ? bad.errors : bad.warnings}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </Folder>
              );
            })}
          </Folder>

          {/* PLC tags */}
          <Folder
            id="tags"
            depth={1}
            icon={<TagsIcon className="w-4 h-4 text-sky-500 shrink-0" />}
            label="PLC tags"
            count={project.tagTables.reduce((n, t) => n + t.tags.length, 0)}
          >
            <button
              className={`w-full flex items-center gap-1.5 py-1 pe-2 text-left
                ${selection.what === 'tags' && !selection.tableId
                ? 'bg-blue-100 font-semibold' : 'hover:bg-blue-50'}`}
              style={{ paddingInlineStart: 2 * 14 + 4 }}
              onClick={() => onSelect({ what: 'tags', tableId: null })}
            >
              <TableIcon className="w-3.5 h-3.5 shrink-0 text-gray-400" />
              Show all tags
            </button>
            {project.tagTables.map(t => (
              <button
                key={t.id}
                className={`w-full flex items-center gap-1.5 py-1 pe-2 text-left
                  ${selection.what === 'tags' && selection.tableId === t.id
                  ? 'bg-blue-100 font-semibold' : 'hover:bg-blue-50'}`}
                style={{ paddingInlineStart: 2 * 14 + 4 }}
                onClick={() => onSelect({ what: 'tags', tableId: t.id })}
              >
                <TableIcon className="w-3.5 h-3.5 shrink-0 text-sky-500" />
                <span className="truncate">{t.name}</span>
                <span className="ms-auto text-[10px] text-gray-400">{t.tags.length}</span>
              </button>
            ))}
          </Folder>

          {/* PLC data types */}
          <Folder
            id="types"
            depth={1}
            icon={<LayersIcon className="w-4 h-4 text-purple-500 shrink-0" />}
            label="PLC data types"
            count={(byKind.get('UDT') ?? []).length}
          >
            {!readOnly && (
              <button
                className="w-full flex items-center gap-1.5 py-1 pe-2 text-left text-blue-700 hover:bg-blue-50"
                style={{ paddingInlineStart: 2 * 14 + 4 }}
                onClick={() => onAddBlock('UDT')}
              >
                <PlusIcon className="w-3.5 h-3.5 shrink-0" /> Add new data type
              </button>
            )}
            {(byKind.get('UDT') ?? []).map(b => (
              <button
                key={b.id}
                className={`w-full flex items-center gap-1.5 py-1 pe-2 text-left
                  ${selection.what === 'block' && selection.id === b.id
                  ? 'bg-blue-100 font-semibold' : 'hover:bg-blue-50'}`}
                style={{ paddingInlineStart: 2 * 14 + 4 }}
                onClick={() => onSelect({ what: 'block', id: b.id })}
                onContextMenu={e => {
                  e.preventDefault(); e.stopPropagation();
                  setMenu({ x: e.clientX, y: e.clientY, blockId: b.id });
                }}
              >
                <LayersIcon className="w-3.5 h-3.5 shrink-0 text-purple-500" />
                <span className="truncate">{b.name}</span>
              </button>
            ))}
          </Folder>
        </Folder>
      </div>

      {menu && (
        <MenuBox
          x={menu.x} y={menu.y}
          className="z-[150] w-56 bg-white border border-gray-200 shadow-lg rounded-md py-1"
        >
          {menu.folder && (
            <Item
              icon={<PlusIcon className="w-3.5 h-3.5" />}
              label="Add new block…"
              onClick={() => { onAddBlock(menu.folder as PlcBlockKind); setMenu(null); }}
            />
          )}
          {menu.blockId && (() => {
            const block = project.blocks.find(b => b.id === menu.blockId);
            if (!block) return null;
            return (
              <>
                <Item
                  icon={<PencilIcon className="w-3.5 h-3.5" />}
                  label="Rename…"
                  hint="Every call of it is renamed too"
                  onClick={() => { rename(block); setMenu(null); }}
                />
                <Item
                  icon={<CopyIcon className="w-3.5 h-3.5" />}
                  label="Duplicate"
                  onClick={() => { duplicate(block); setMenu(null); }}
                />
                <Item
                  icon={<DownloadIcon className="w-3.5 h-3.5" />}
                  label="Export as SCL source"
                  onClick={() => { onExportBlock(block); setMenu(null); }}
                />
                <div className="border-t border-gray-100 my-1" />
                <Item
                  icon={<TrashIcon className="w-3.5 h-3.5" />}
                  label="Delete"
                  danger
                  onClick={() => { remove(block); setMenu(null); }}
                />
              </>
            );
          })()}
        </MenuBox>
      )}
    </div>
  );
};

const Item: React.FC<{
  icon: React.ReactNode; label: string; hint?: string; danger?: boolean; onClick: () => void;
}> = ({ icon, label, hint, danger, onClick }) => (
  <button
    className={`w-full text-left px-3 py-1.5 text-[12px] hover:bg-gray-100
      ${danger ? 'text-red-600' : ''}`}
    onClick={onClick}
  >
    <span className="flex items-center gap-2">{icon} {label}</span>
    {hint && <span className="block ps-6 text-[10px] text-gray-400">{hint}</span>}
  </button>
);
