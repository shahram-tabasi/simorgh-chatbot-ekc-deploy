// src/utils/tpmsProjectImport.ts
//
// A whole TPMS project, revision by revision.
//
// The single-switchgear import (tpmsImport.ts) turns one scope at one revision
// into a patch. This builds on it: for each revision TPMS holds, it lays every
// switchgear of the project into one project snapshot. Those snapshots become
// the revisions on this side, so REV 2 here is TPMS revision 2 — the same
// drawing set, the same lines, the same parts.
//
// Pure: no network, no persistence. `services/tpmsSync.ts` does both.
import { ProjectData, TpmsSyncState } from '../types/project';
import { buildTpmsImport, legacyBaseName, TpmsLine, TpmsPayload } from './tpmsImport';
import { type Tier, TIERS, emptyTiers } from './tiers';

export interface TpmsSwitchgear {
  scopeId: number;
  scopeName: string;
  switchgearType: string;
  panelType: 'LV' | 'MV';
  cellCount: string;
  tag: string;
  device: { name: string; type: Tier; properties: Record<string, any> };
  slotProperties: Record<string, string>;
}

/** Everything about a TPMS project except its feeder lines. */
export interface TpmsProjectHeader {
  success?: boolean;
  project: TpmsPayload['project'];
  techSettings: ProjectData['techSettings'];
  columnNames: Record<string, string>;
  revisions: number[];
  switchgears: TpmsSwitchgear[];
}

/** One revision of the project: the lines of every switchgear in it. */
export interface TpmsRevisionData {
  success?: boolean;
  revision: number;
  switchgears: {
    scopeId: number;
    scopeName: string;
    lines: TpmsLine[];
    counts?: { lines: number; parts: number };
  }[];
}

export interface TpmsSnapshotSummary {
  revision: number;
  switchgears: number;
  rows: number;
  parts: number;
  templates: number;
}

// Was this piece of the project put there by a TPMS import? Newer imports mark
// themselves; the first ones only left the TPMS hierarchy path and the
// `properties.tpms` block behind, so both are accepted.
const templateFromTpms = (t: any) => t?.source === 'tpms' || t?.hierarchy?.path?.[0] === 'TPMS';
const equipmentFromTpms = (e: any) => !!e?.properties?.tpms;

/**
 * The project with the switchgears TPMS has *dropped* taken out of it — the
 * base every snapshot is built on.
 *
 * This used to remove everything TPMS had ever put in the project and build it
 * all again from scratch. That threw away the engineer's work every time the
 * project was read a second time: a panel specification they had corrected, a
 * row they had added in Device Selection, a template they had refined. The
 * import writes over what it finds anyway — it matches on the scope id — so
 * the only thing that has to go here is the switchgear TPMS no longer has.
 * Everything else is left standing and merged into.
 */
export function stripTpmsContent(data: ProjectData, header?: TpmsProjectHeader): ProjectData {
  const scopeIds = new Set((header?.switchgears ?? []).map(s => s.scopeId));
  const scopeNames = new Set((header?.switchgears ?? []).map(s => s.scopeName));

  // Is the switchgear this piece came from still in TPMS? Older imports left
  // no scope id behind, so the name is accepted as well. With no header in
  // hand nothing can be said to be gone, and nothing is removed.
  const gone = (scopeId: unknown, name: unknown) => {
    if (!header) return false;
    if (scopeId != null && scopeIds.has(Number(scopeId))) return false;
    return !scopeNames.has(String(name ?? ''));
  };

  const templates = { ...(data.templates ?? emptyTiers()) };
  for (const tier of TIERS) {
    templates[tier] = (templates[tier] ?? []).filter(
      (t: any) => {
        if (!templateFromTpms(t)) return true;
        // Shared by several switchgears: it goes when the last of them has.
        if (Array.isArray(t?.tpmsScopeIds) && t.tpmsScopeIds.length > 0) {
          return !header || t.tpmsScopeIds.some((id: number) => scopeIds.has(Number(id)));
        }
        return !gone(t?.tpmsScopeId, t?.hierarchy?.path?.[1]);
      });
  }

  const library = { ...(data.deviceLibrary ?? emptyTiers()) };
  for (const tier of TIERS) {
    library[tier] = (library[tier] ?? []).filter(
      (d: any) => d?.source !== 'tpms' || !gone(d?.tpmsScopeId, d?.name));
  }

  return {
    ...data,
    templates,
    deviceLibrary: library,
    equipments: (data.equipments ?? []).filter(
      (e: any) => !equipmentFromTpms(e) || !gone(e?.properties?.tpms?.scopeId, e?.name)),
  };
}

/**
 * One revision of the project as a complete ProjectData: master data,
 * technical settings, a Device Library entry per switchgear, the switchgears
 * with their rows, and the templates behind them.
 */
export function buildTpmsRevisionSnapshot(
  base: ProjectData,
  header: TpmsProjectHeader,
  revisionData: TpmsRevisionData,
): { data: ProjectData; summary: TpmsSnapshotSummary } {
  let data = stripTpmsContent(base, header);
  const summary: TpmsSnapshotSummary = {
    revision: revisionData.revision,
    switchgears: 0, rows: 0, parts: 0, templates: 0,
  };

  // What TPMS said last time. Every specification below is merged against it,
  // so a field TPMS has changed comes across and a field the engineer has
  // changed stays theirs.
  const baseline = base.tpmsSync?.baseline;

  const linesByScope = new Map<number, TpmsRevisionData['switchgears'][number]>();
  for (const entry of revisionData.switchgears ?? []) linesByScope.set(entry.scopeId, entry);

  // Every switchgear TPMS lists is a panel of the project, drafted or not.
  //
  // A switchgear with no lines at this revision used to be left out of it, on
  // the idea that it "did not exist yet". But TPMS numbers revisions per
  // switchgear: a panel drafted at REV 1 and never revised has no lines at
  // REV 5, and a panel nobody has drafted has none at all — and both are
  // still panels of the project, with a specification that belongs in the
  // Device Library. On a project of 84 panels that rule kept 14. The lines
  // now arrive as each switchgear stood at this revision (the read asks for
  // its newest revision up to this one), so a switchgear without any simply
  // has not been drafted, and comes in with its specification and no rows.
  for (const sw of header.switchgears ?? []) {
    const entry = linesByScope.get(sw.scopeId);
    const lines = entry?.lines ?? [];

    const payload: TpmsPayload = {
      project: header.project,
      scope: {
        scopeId: sw.scopeId,
        scopeName: sw.scopeName,
        switchgearType: sw.switchgearType,
        panelType: sw.panelType,
        cellCount: sw.cellCount,
        revision: revisionData.revision,
        tag: sw.tag,
      },
      techSettings: header.techSettings,
      device: sw.device,
      columnNames: header.columnNames,
      slotProperties: sw.slotProperties,
      baseline: {
        techSettings: baseline?.techSettings,
        device: baseline?.devices?.[String(sw.scopeId)],
      },
      lines,
      counts: {
        lines: lines.length,
        parts: entry?.counts?.parts ?? 0,
        templates: 0,
      },
    };

    const { patch, summary: one } = buildTpmsImport(data, payload, {
      projectData: true, techSettings: true, deviceLibrary: true, equipment: true,
    });
    data = { ...data, ...patch };
    summary.switchgears += 1;
    summary.rows += one.rows;
    summary.parts += one.parts;
    summary.templates += one.templates;
  }

  data = foldTpmsCopies(data, header);
  return { data, summary };
}

/**
 * The copies an earlier read made of one template, folded back into it.
 *
 * Reads before "one name, one template" gave the same TPMS name a template per
 * switchgear and told them apart with a number — "COUPLING (2)" … "(7)" — or
 * the switchgear's name. This read has made the one template each name should
 * have (it carries `tpmsName`); every older copy of it still waiting in BPMS
 * is removed, and any row that pointed at a copy points at the one. A copy the
 * engineer has filed somewhere is theirs and is left alone.
 */
function foldTpmsCopies(data: ProjectData, header: TpmsProjectHeader): ProjectData {
  const scopeNames = new Set((header.switchgears ?? []).map(s => s.scopeName));
  const templates = { ...(data.templates ?? emptyTiers()) };
  const moved = new Map<string, { id: string; name: string }>();

  for (const tier of TIERS) {
    const list = templates[tier] ?? [];
    const canonical = new Map<string, { id: string; name: string }>();
    for (const t of list) if (t.tpmsName) canonical.set(t.tpmsName, { id: t.id, name: t.name });
    if (canonical.size === 0) continue;
    templates[tier] = list.filter(t => {
      const waiting = templateFromTpms(t) && !t.tpmsName && (t.hierarchy?.path?.[0] ?? 'TPMS') === 'TPMS';
      if (!waiting) return true;
      const one = canonical.get(legacyBaseName(t.name, scopeNames)) ?? canonical.get(t.name);
      if (!one || one.id === t.id) return true;
      moved.set(t.id, one);
      return false;
    });
  }
  if (moved.size === 0) return data;

  const repoint = <R extends { templateId?: string; templateName?: string }>(row: R): R => {
    const to = row.templateId ? moved.get(row.templateId) : undefined;
    return to ? { ...row, templateId: to.id, templateName: to.name } : row;
  };
  return {
    ...data,
    templates,
    equipments: (data.equipments ?? []).map(eq => ({ ...eq, devices: (eq.devices ?? []).map(repoint) })),
    devices: (data.devices ?? []).map(repoint),
  };
}

/** The link back to TPMS that the project carries from here on. */
export function buildTpmsSyncState(
  header: TpmsProjectHeader,
  master: 'tpms' | 'suite' = 'tpms',
  previous?: TpmsSyncState,
): TpmsSyncState {
  // Who owns the project from here on.
  //
  // TPMS owns a project it is drafting: it is read again on every open and the
  // suite shows it read-only. But a project TPMS holds no revision for has no
  // draft to own — panels and specifications, nothing on them. That project is
  // handed to the engineer to draft *here*, editable from the moment it opens.
  // And once the suite has taken a project over, reading TPMS again never
  // takes it back: that is the engineer's project now.
  const owner: 'tpms' | 'suite' =
    previous?.master === 'suite' ? 'suite'
      : (header.revisions ?? []).length === 0 ? 'suite'
      : master;

  // What TPMS delivered this time, kept so the next read can tell a field TPMS
  // changed from a field the engineer changed.
  const devices: Record<string, Record<string, unknown>> = {};
  for (const sw of header.switchgears ?? []) {
    if (sw.scopeId != null) devices[String(sw.scopeId)] = { ...(sw.device?.properties ?? {}) };
  }

  return {
    ...(previous ?? {}),
    projectMainId: header.project.projectMainId ?? previous?.projectMainId ?? 0,
    oeNumber: header.project.oeNumber,
    projectName: header.project.projectName,
    master: owner,
    baseline: {
      techSettings: (header.techSettings ?? {}) as Record<string, Record<string, unknown>>,
      devices,
    },
    lastSyncedAt: new Date().toISOString(),
    revisions: [...(header.revisions ?? [])],
    switchgears: (header.switchgears ?? []).map(s => ({
      scopeId: s.scopeId, scopeName: s.scopeName, panelType: s.panelType,
    })),
  };
}
