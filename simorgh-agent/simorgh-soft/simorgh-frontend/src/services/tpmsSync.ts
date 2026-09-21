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
  /** Switchgears that could not be read, so the import can say so instead of
   *  quietly producing a project with holes in it. */
  problems: string[];
}

export interface TpmsSyncOptions {
  /** 'all' brings in every TPMS revision, 'newest' only the last one — the
   *  quick way in for a project with a long history. */
  revisions?: 'all' | 'newest';
  /** A header already read (the dialog reads one to show what is coming).
   *  Passing it back saves reading the whole project description twice —
   *  which on a forty-panel project is not a cheap read. */
  header?: TpmsProjectHeader;
}

// How many switchgears are read at once. Small enough that each request stays
// well inside any proxy's read timeout, large enough that a forty-panel
// project doesn't crawl.
const SCOPE_BATCH = 3;

// MongoDB stores one document in at most 16 MB, and a revision's snapshot is
// one document. A plant-sized project runs around 1 MB, so this is headroom —
// but a project that did cross it would fail with a database error nobody
// could read, so it is checked here and said plainly instead.
const MAX_SNAPSHOT_BYTES = 14 * 1024 * 1024;

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
  options: TpmsSyncOptions = {},
): Promise<TpmsSyncResult> {
  const say = (m: string, d: number, t: number) => { try { onProgress?.(m, d, t); } catch { /* UI only */ } };
  const problems: string[] = [];

  say('Reading the project from TPMS…', 0, 1);
  const header: TpmsProjectHeader =
    options.header ?? await tpmsService.getProjectHeader(projectMainId);

  // A project with no drafts at all still imports — it just has no lines yet.
  const all = (header.revisions ?? []).length > 0 ? [...header.revisions].sort((a, b) => a - b) : [0];
  const revisions = options.revisions === 'newest' ? all.slice(-1) : all;
  const switchgears = header.switchgears ?? [];
  const total = revisions.length * Math.max(1, switchgears.length) + 2;

  // The panel specifications, one switchgear at a time. The header no longer
  // carries them (that read is what made a big project hang), so they are
  // filled in here — and a panel that cannot be read costs its own
  // specification, not the whole import.
  for (let i = 0; i < switchgears.length; i += SCOPE_BATCH) {
    const batch = switchgears.slice(i, i + SCOPE_BATCH);
    say(`Panel specifications — ${batch[0].scopeName} (${i + 1}/${switchgears.length})`, 0, total);
    await Promise.all(batch.map(async sw => {
      try {
        const panel = await tpmsService.getProjectPanel(projectMainId, sw.scopeId);
        sw.device = {
          ...(sw.device ?? { name: sw.scopeName, type: sw.panelType, properties: {} }),
          properties: { ...(sw.device?.properties ?? {}), ...(panel.properties ?? {}) },
        };
      } catch (err) {
        problems.push(`Panel specification · ${sw.scopeName}: ${(err as Error).message}`);
      }
    }));
  }

  // Every revision, oldest first, each one a complete project of its own —
  // and each one read switchgear by switchgear, in small batches, so that a
  // project with forty panels and a decade of revisions never hangs on one
  // enormous request.
  const base: ProjectData = { ...defaultProjectData, ...(existing ?? {}) };
  const snapshots: { revision: number; data: ProjectData; summary: TpmsSnapshotSummary }[] = [];
  let step = 1;

  for (const revision of revisions) {
    const entries: TpmsRevisionData['switchgears'] = [];

    if ((header.revisions ?? []).length > 0) {
      for (let i = 0; i < switchgears.length; i += SCOPE_BATCH) {
        const batch = switchgears.slice(i, i + SCOPE_BATCH);
        say(`Revision ${revision} — ${batch[0].scopeName} (${i + 1}/${switchgears.length})`, step, total);
        const results = await Promise.all(batch.map(async sw => {
          try {
            const data = await tpmsService.getProjectRevision(projectMainId, revision, sw.scopeId);
            return (data.switchgears ?? []) as TpmsRevisionData['switchgears'];
          } catch (err) {
            // One unreadable switchgear must not cost the whole project: the
            // rest still comes in, and the import says what is missing.
            problems.push(`REV ${revision} · ${sw.scopeName}: ${(err as Error).message}`);
            return [] as TpmsRevisionData['switchgears'];
          }
        }));
        for (const list of results) entries.push(...list);
        step += batch.length;
      }
    } else {
      step += 1;
    }

    const { data, summary } = buildTpmsRevisionSnapshot(base, header, { revision, switchgears: entries });
    snapshots.push({ revision, data, summary });
  }

  const newest = snapshots[snapshots.length - 1];
  const sync = buildTpmsSyncState(header, 'tpms', existing?.tpmsSync);
  const projectToSave: ProjectData = {
    ...newest.data,
    tpmsSync: sync,
    projectName: header.project.projectName || existing?.projectName || newest.data?.projectName || 'TPMS Project',
    projectNumber: header.project.oeNumber || existing?.projectNumber || newest.data?.projectNumber || '',
  };

  // ── The project document ────────────────────────────────────────────────
  say('Saving the project…', step, total);
  // `rev` goes with `_id`. It is the database's own version counter, moved by
  // $inc on the server, and a body that carries it asks Mongo to set and
  // increment the same field in one update — which it refuses. This is the
  // call that showed it: opening a TPMS project saves the moment it is read,
  // and the project it had just read carried the rev it was read at.
  const { _id, rev, ...body } = projectToSave as any;
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

  // Only the revisions actually read are rewritten; with "newest only" the
  // ones already stored here are left exactly as they are.
  const wanted = new Set((options.revisions === 'newest' ? all : revisions).map(String));
  const out: Revision[] = [];

  for (const snapshot of snapshots) {
    const number = String(snapshot.revision);
    const snapshotData = { ...snapshot.data, _id: projectId, tpmsSync: sync };
    const size = JSON.stringify(snapshotData).length;
    if (size > MAX_SNAPSHOT_BYTES) {
      problems.push(
        `REV ${number}: ${(size / 1048576).toFixed(1)} MB is more than one MongoDB ` +
        `document holds (16 MB), so this revision was not stored.`);
      continue;
    }
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

    // One revision that will not save must not cost the whole import: it is
    // reported and the rest still lands.
    const previous = known.find(r => r.revisionNumber === number);
    try {
      out.push(previous?._id
        ? await projectService.updateRevision(previous._id, fields)
        : await projectService.createRevision(fields as any));
    } catch (err) {
      problems.push(`REV ${number}: ${(err as Error).message}`);
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
    problems,
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
  options: TpmsSyncOptions = {},
): Promise<TpmsSyncResult | null> {
  const sync = project.tpmsSync;
  if (!sync || sync.master !== 'tpms' || !sync.projectMainId) return null;
  return syncProjectFromTpms(sync.projectMainId, project, onProgress, options);
}
