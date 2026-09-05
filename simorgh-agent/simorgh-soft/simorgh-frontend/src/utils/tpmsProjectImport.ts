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
import { buildTpmsImport, TpmsLine, TpmsPayload } from './tpmsImport';

export interface TpmsSwitchgear {
  scopeId: number;
  scopeName: string;
  switchgearType: string;
  panelType: 'LV' | 'MV';
  cellCount: string;
  tag: string;
  device: { name: string; type: 'LV' | 'MV' | 'HV'; properties: Record<string, any> };
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
 * The project without anything TPMS put in it — the base every snapshot is
 * built on, so a line, a template or a switchgear that TPMS no longer has
 * disappears here too. Whatever the user added themselves is untouched.
 */
export function stripTpmsContent(data: ProjectData, header?: TpmsProjectHeader): ProjectData {
  const scopeIds = new Set((header?.switchgears ?? []).map(s => s.scopeId));
  const scopeNames = new Set((header?.switchgears ?? []).map(s => s.scopeName));
  const libraryFromTpms = (d: any) =>
    d?.source === 'tpms' ||
    (d?.tpmsScopeId != null && scopeIds.has(d.tpmsScopeId)) ||
    scopeNames.has(d?.name);

  const templates = { ...(data.templates ?? { LV: [], MV: [], HV: [] }) };
  for (const tier of ['LV', 'MV', 'HV'] as const) {
    templates[tier] = (templates[tier] ?? []).filter(t => !templateFromTpms(t));
  }

  const library = { ...(data.deviceLibrary ?? { LV: [], MV: [], HV: [] }) };
  for (const tier of ['LV', 'MV', 'HV'] as const) {
    library[tier] = (library[tier] ?? []).filter(d => !libraryFromTpms(d));
  }

  return {
    ...data,
    templates,
    deviceLibrary: library,
    equipments: (data.equipments ?? []).filter(e => !equipmentFromTpms(e)),
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

  const linesByScope = new Map<number, TpmsRevisionData['switchgears'][number]>();
  for (const entry of revisionData.switchgears ?? []) linesByScope.set(entry.scopeId, entry);

  for (const sw of header.switchgears ?? []) {
    const entry = linesByScope.get(sw.scopeId);
    // A switchgear with no lines at this revision did not exist yet (or was
    // emptied); it simply isn't in this snapshot.
    if (!entry || entry.lines.length === 0) continue;

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
      lines: entry.lines,
      counts: {
        lines: entry.lines.length,
        parts: entry.counts?.parts ?? 0,
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

  return { data, summary };
}

/** The link back to TPMS that the project carries from here on. */
export function buildTpmsSyncState(
  header: TpmsProjectHeader,
  master: 'tpms' | 'suite' = 'tpms',
  previous?: TpmsSyncState,
): TpmsSyncState {
  return {
    ...(previous ?? {}),
    projectMainId: header.project.projectMainId ?? previous?.projectMainId ?? 0,
    oeNumber: header.project.oeNumber,
    projectName: header.project.projectName,
    master,
    lastSyncedAt: new Date().toISOString(),
    revisions: [...(header.revisions ?? [])],
    switchgears: (header.switchgears ?? []).map(s => ({
      scopeId: s.scopeId, scopeName: s.scopeName, panelType: s.panelType,
    })),
  };
}
