// src/services/tpmsSync.ts
//
// Opening a project from TPMS, and keeping it in step with TPMS afterwards.
//
// The rule the whole thing turns on:
//
//   While the project is TPMS-mastered, TPMS owns it. Every time it is opened
//   it is read again — every switchgear, every revision — and written to
//   MongoDB, and the app refuses edits. The moment a revision is raised inside
//   Design Suite the suite takes over: syncing stops and the project is edited
//   here from then on.
//
// TPMS revision N becomes REV N on this side, carrying that revision's whole
// project as its snapshot, so the revision list here is the revision history
// there — and two of them can be compared in Output Types.
import { ProjectData, Revision } from '../types/project';
import { projectService, tpmsService } from './projectService';
import { defaultProjectData } from '../context/ProjectContext';
import {
  TpmsProjectHeader, TpmsRevisionData, TpmsSnapshotSummary,
  buildTpmsRevisionSnapshot, buildTpmsSyncState,
} from '../utils/tpmsProjectImport';

export interface TpmsSyncResult {
  project: ProjectData;
  revisions: Revision[];
  /** The newest revision — the one to open. */
  current: Revision | null;
  header: TpmsProjectHeader;
  summaries: TpmsSnapshotSummary[];
  created: boolean;
}

export type TpmsSyncProgress = (message: string, done: number, total: number) => void;

/** The project on this side that stands for a TPMS project, if there is one. */
export function findLinkedProject(projects: ProjectData[], header: TpmsProjectHeader): ProjectData | null {
  const pid = header.project.projectMainId != null ? String(header.project.projectMainId) : '';
  const oe = (header.project.oeNumber || '').trim();
  const name = (header.project.projectName || '').trim().toLowerCase();
  return projects.find(p =>
    (pid && String(p.tpmsSync?.projectMainId ?? '') === pid) ||
    (pid && (p.projectId || '').trim() === pid) ||
    (oe && (p.projectNumber || '').trim() === oe) ||
    (name && p.projectName.trim().toLowerCase() === name)) ?? null;
}

/**
 * Read a whole TPMS project and write it to MongoDB: the project itself, and
 * one revision per TPMS revision.
 *
 * `existing` is the project on this side to refresh, when there is one. A
 * project whose owner is already the suite is left alone — the caller decides
 * what to do about that (it is reported through `skipped`).
 */
export async function syncProjectFromTpms(
  projectMainId: number,
  existing: ProjectData | null,
  onProgress?: TpmsSyncProgress,
): Promise<TpmsSyncResult> {
  const say = (m: string, d: number, t: number) => { try { onProgress?.(m, d, t); } catch { /* UI only */ } };

  say('Reading the project from TPMS…', 0, 1);
  const header: TpmsProjectHeader = await tpmsService.getProjectHeader(projectMainId);

  // A project with no drafts at all still imports — it just has no lines yet.
  const revisions = (header.revisions ?? []).length > 0 ? [...header.revisions].sort((a, b) => a - b) : [0];
  const total = revisions.length + 2;

  // Every revision, oldest first, each one a complete project of its own.
  const base: ProjectData = { ...defaultProjectData, ...(existing ?? {}) };
  const snapshots: { revision: number; data: ProjectData; summary: TpmsSnapshotSummary }[] = [];
  let step = 1;
  for (const revision of revisions) {
    say(`Reading revision ${revision}…`, step, total);
    let revisionData: TpmsRevisionData = { revision, switchgears: [] };
    if ((header.revisions ?? []).length > 0) {
      revisionData = await tpmsService.getProjectRevision(projectMainId, revision);
    }
    const { data, summary } = buildTpmsRevisionSnapshot(base, header, revisionData);
    snapshots.push({ revision, data, summary });
    step += 1;
  }

  const newest = snapshots[snapshots.length - 1];
  const sync = buildTpmsSyncState(header, 'tpms', existing?.tpmsSync);
  const projectToSave: ProjectData = { ...newest.data, tpmsSync: sync };

  // ── The project document ────────────────────────────────────────────────
  say('Saving the project…', step, total);
  const { _id, ...body } = projectToSave as any;
  const saved: ProjectData = existing?._id
    ? await projectService.updateProject(existing._id, body)
    : await projectService.createProject(body);
  step += 1;

  // ── One revision per TPMS revision ──────────────────────────────────────
  say('Writing the revisions…', step, total);
  const projectId = saved._id!;
  // The backend creates REV 0 by itself when a project has none; reading the
  // list first means that auto-created revision is in hand and can be reused
  // or removed rather than left behind as a stray.
  let known: Revision[] = [];
  try { known = await projectService.getRevisions(projectId); } catch { known = []; }

  const wanted = new Set(revisions.map(String));
  const out: Revision[] = [];

  for (const snapshot of snapshots) {
    const number = String(snapshot.revision);
    const snapshotData = { ...snapshot.data, _id: projectId, tpmsSync: sync };
    const fields = {
      projectId,
      revisionNumber: number,
      revisionName: `TPMS REV ${number}`,
      description:
        `Read from TPMS on ${new Date().toLocaleString()} — ` +
        `${snapshot.summary.switchgears} switchgear(s), ${snapshot.summary.rows} line(s), ` +
        `${snapshot.summary.parts} part(s).`,
      createdBy: 'tpms',
      projectSnapshot: snapshotData,
      isLocked: false,
      source: 'tpms' as const,
      tpmsRevision: snapshot.revision,
    };

    const previous = known.find(r => r.revisionNumber === number);
    if (previous?._id) {
      out.push(await projectService.updateRevision(previous._id, fields));
    } else {
      out.push(await projectService.createRevision(fields as any));
    }
  }

  // Revisions this side has that TPMS does not: one this import made from a
  // revision since removed there, or the empty REV 0 the backend creates by
  // itself for a project that has none. A revision raised in Design Suite is
  // never touched — that one is the user's work, and it means the suite has
  // taken the project over anyway.
  for (const revision of known) {
    if (wanted.has(revision.revisionNumber) || !revision._id) continue;
    if (revision.source === 'suite') continue;
    const autoEmpty =
      revision.createdBy === 'system' ||
      ((revision.projectSnapshot?.equipments ?? []).length === 0);
    if (revision.source === 'tpms' || autoEmpty) {
      try { await projectService.deleteRevision(revision._id, ''); }
      catch (err) { console.warn(`Could not remove revision ${revision.revisionNumber}:`, err); }
    }
  }

  const current = out.length > 0 ? out[out.length - 1] : null;
  say('Done.', total, total);

  return {
    project: current?.projectSnapshot ? { ...current.projectSnapshot, _id: projectId } : saved,
    revisions: [...out].reverse(),   // newest first, as the rest of the app expects
    current,
    header,
    summaries: snapshots.map(s => s.summary),
    created: !existing?._id,
  };
}

/**
 * Refresh an already-linked project, if TPMS is still its master. Returns null
 * when there is nothing to do (no link, or the suite has taken over), so the
 * caller can just open what it has.
 */
export async function resyncIfTpmsMastered(
  project: ProjectData,
  onProgress?: TpmsSyncProgress,
): Promise<TpmsSyncResult | null> {
  const sync = project.tpmsSync;
  if (!sync || sync.master !== 'tpms' || !sync.projectMainId) return null;
  return syncProjectFromTpms(sync.projectMainId, project, onProgress);
}
