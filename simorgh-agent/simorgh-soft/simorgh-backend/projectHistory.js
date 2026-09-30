// simorgh-backend/projectHistory.js
//
// Every version of every project, kept on the server.
//
// This is the layer that means "the data went" is a sentence with an answer.
// Everything else protects the current document — the version guard that stops
// two computers overwriting each other, the retry, the dialog when nothing is
// being written. None of that helps once something wrong has been saved on
// purpose: a row deleted, a switchgear cleared, an import that replaced more
// than it should have. For that there has to be a yesterday to go back to.
//
// So: before a project is overwritten, the version being replaced is put here.
// Not in the browser — a copy that goes with a cleared cache is a copy nobody
// can rely on — and not only in a nightly dump, which is a day wide. Here,
// beside the project, on every save.
//
// Three things make it affordable:
//
//   **Gzip.** A project is JSON and JSON compresses ten to twenty times. Sixty
//   versions of a five-megabyte project is three hundred megabytes stored
//   plainly and about twenty compressed.
//
//   **Spacing.** Autosave writes every five seconds while somebody types. Sixty
//   versions five seconds apart is five minutes of history, which is no use.
//   A version is kept when the newest one is more than a couple of minutes old
//   — so sixty of them reach back over two hours of real work.
//
//   **A cap.** Sixty per project, oldest dropped first.
//
// Nothing here is allowed to fail a save. A history that cannot be written is
// logged and the save goes through: the copy is a safety net, and a safety net
// that catches the tightrope walker on the way up is not one.

import zlib from 'zlib';
import { promisify } from 'util';
import { ObjectId } from 'mongodb';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export const COLLECTION = 'projectHistory';

/** How many versions of one project are kept. */
export const KEEP_VERSIONS = 60;

/** How close together two kept versions may be, in milliseconds. */
export const MIN_SPACING_MS = 2 * 60 * 1000;

/** What is in a project, for a list somebody has to choose from. */
function describe(doc) {
  const equipments = Array.isArray(doc?.equipments) ? doc.equipments : [];
  const templates = ['LV', 'MV', 'HV']
    .reduce((n, t) => n + (doc?.templates?.[t]?.length ?? 0), 0);
  return {
    templates,
    equipments: equipments.length,
    rows: equipments.reduce((n, e) => n + (e?.devices?.length ?? 0), 0),
    // Named, because the choice is often "which switchgear do I want back".
    switchgears: equipments.map(e => ({
      id: String(e?.id ?? ''),
      name: String(e?.name ?? ''),
      type: String(e?.type ?? ''),
      rows: e?.devices?.length ?? 0,
    })),
  };
}

export async function ensureHistoryIndexes(db) {
  try {
    await db.collection(COLLECTION).createIndex({ projectId: 1, savedAt: -1 });
    console.log('Project history is indexed');
  } catch (error) {
    console.warn('Could not index the project history:', error.message);
  }
}

/**
 * Keep the version that is about to be replaced.
 *
 * `previous` is the document as it was before the write that is replacing it.
 * Answers quietly — a save must never fail because its safety net did.
 */
export async function keepVersion(db, previous, reason = 'saved') {
  if (!db || !previous?._id) return false;
  try {
    const projectId = String(previous._id);
    const newest = await db.collection(COLLECTION)
      .find({ projectId }).sort({ savedAt: -1 }).limit(1).next();

    // Close together in time and no bigger a change than a few keystrokes:
    // one version of that is enough.
    if (newest && Date.now() - new Date(newest.savedAt).getTime() < MIN_SPACING_MS) {
      return false;
    }

    const json = JSON.stringify(previous);
    const record = {
      projectId,
      projectName: String(previous.projectName ?? ''),
      rev: previous.rev ?? null,
      // When this version was replaced, and when it had last been edited.
      savedAt: new Date().toISOString(),
      changedOn: previous.changedOn ?? null,
      reason,
      plainSize: json.length,
      counts: describe(previous),
      gz: await gzip(Buffer.from(json, 'utf8')),
    };
    await db.collection(COLLECTION).insertOne(record);
    await prune(db, projectId);
    return true;
  } catch (error) {
    console.warn('Could not keep a project version:', error.message);
    return false;
  }
}

async function prune(db, projectId) {
  const extra = await db.collection(COLLECTION)
    .find({ projectId }, { projection: { _id: 1 } })
    .sort({ savedAt: -1 })
    .skip(KEEP_VERSIONS)
    .toArray();
  if (extra.length === 0) return;
  await db.collection(COLLECTION).deleteMany({ _id: { $in: extra.map(d => d._id) } });
}

export function registerProjectHistoryRoutes(app, getDb) {
  /** The versions of one project, newest first — without the documents. */
  app.get('/api/projects/:id/history', async (req, res) => {
    try {
      const rows = await getDb().collection(COLLECTION)
        .find({ projectId: String(req.params.id) }, { projection: { gz: 0 } })
        .sort({ savedAt: -1 })
        .limit(KEEP_VERSIONS)
        .toArray();
      res.json(rows.map(r => ({ ...r, _id: String(r._id) })));
    } catch (error) {
      console.error('Error listing project history:', error);
      res.status(500).json({ error: `Failed to list history: ${error.message}` });
    }
  });

  /** One version, whole, as the project was. */
  app.get('/api/projects/:id/history/:versionId', async (req, res) => {
    try {
      if (!ObjectId.isValid(req.params.versionId)) {
        return res.status(404).json({ error: 'No such version' });
      }
      const row = await getDb().collection(COLLECTION)
        .findOne({ _id: new ObjectId(req.params.versionId) });
      if (!row) return res.status(404).json({ error: 'No such version' });
      const json = (await gunzip(row.gz.buffer ?? row.gz)).toString('utf8');
      res.type('application/json').send(json);
    } catch (error) {
      console.error('Error reading a project version:', error);
      res.status(500).json({ error: `Failed to read that version: ${error.message}` });
    }
  });

  /**
   * How much history there is, for the health page.
   *
   * Worth being able to answer without opening a project: "is anything being
   * kept at all" is the question somebody asks the week after they needed it.
   */
  app.get('/api/history-health', async (_req, res) => {
    try {
      const db = getDb();
      const total = await db.collection(COLLECTION).countDocuments();
      const perProject = await db.collection(COLLECTION).aggregate([
        { $group: {
          _id: '$projectId',
          projectName: { $last: '$projectName' },
          versions: { $sum: 1 },
          newest: { $max: '$savedAt' },
          oldest: { $min: '$savedAt' },
          stored: { $sum: { $bsonSize: '$$ROOT' } },
        } },
        { $sort: { newest: -1 } },
      ]).toArray();
      res.json({ total, keepPerProject: KEEP_VERSIONS, projects: perProject });
    } catch (error) {
      res.status(500).json({ error: `Failed to read history health: ${error.message}` });
    }
  });
}
