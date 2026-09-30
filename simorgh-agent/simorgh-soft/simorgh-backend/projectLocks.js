// projectLocks.js
//
// Who is working on what, inside one project.
//
// Several engineers open the same project at once and each works on a part of
// it: one fills in tags and descriptions on a switchgear, another builds a
// template. The project is saved as one document, so two people typing into
// the same switchgear would each save over the other. A lock says "this one is
// mine for now": the switchgear or the template somebody has open is theirs
// until they move on, and anyone else who tries to open it is told who has it.
//
// A lock is held by a *browser tab* (holderId), not by a person, and it lives
// only as long as that tab keeps saying it is there. Every tab sends a
// heartbeat; a lock whose holder has not been heard from for LOCK_TTL_MS is
// free. A closed laptop, a crashed browser, a lost network — none of them can
// leave a switchgear locked for the afternoon.
//
// The heartbeat answers with the project's version as well, so a tab learns
// that a colleague has saved without reading the whole project to find out.

import { ObjectId } from 'mongodb';

export const LOCK_TTL_MS = 45_000;

const KEY_RE = /^(equipment|template):[\w.:-]{1,200}$/;

const clean = (value, max = 80) => String(value ?? '').trim().slice(0, max);

export function registerProjectLockRoutes(app, getDb) {
  const locks = () => getDb().collection('project_locks');
  let indexed = false;

  const ensureIndexes = async () => {
    if (indexed) return;
    // One holder per thing — the database's rule, so two tabs asking at the
    // same moment cannot both be told yes.
    await locks().createIndex({ projectId: 1, key: 1 }, { unique: true, name: 'project_key_unique' });
    // Stale locks are ignored by every query anyway; this only tidies up.
    await locks().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 3600, name: 'expires_ttl' });
    indexed = true;
  };

  const active = async (projectId) =>
    (await locks().find({ projectId, expiresAt: { $gt: new Date() } }).toArray())
      .map(l => ({ key: l.key, holderId: l.holderId, userName: l.userName, since: l.acquiredAt }));

  const projectRev = async (projectId) => {
    if (!ObjectId.isValid(projectId)) return null;
    const doc = await getDb().collection('projects')
      .findOne({ _id: new ObjectId(projectId) }, { projection: { rev: 1 } });
    return doc ? (doc.rev ?? 0) : null;
  };

  // Take a lock, or be told who has it.
  app.post('/api/projects/:id/locks/acquire', async (req, res) => {
    const projectId = req.params.id;
    const key = clean(req.body?.key, 220);
    const holderId = clean(req.body?.holderId);
    const userName = clean(req.body?.userName) || 'Someone';
    if (!KEY_RE.test(key) || !holderId) {
      return res.status(400).json({ error: 'key and holderId are required' });
    }
    try {
      await ensureIndexes();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);
      try {
        // An expired lock is nobody's: cleared first, so what follows only
        // has to tell "mine" from "somebody else's".
        await locks().deleteOne({ projectId, key, expiresAt: { $lte: now } });
        // Free or already this tab's: take it, or keep it. Held by anyone
        // else, the filter matches nothing, the upsert tries to insert a
        // second lock on the same key, and the unique index refuses it.
        await locks().updateOne(
          { projectId, key, holderId },
          { $set: { userName, expiresAt }, $setOnInsert: { acquiredAt: now } },
          { upsert: true },
        );
        return res.json({ ok: true });
      } catch (err) {
        if (err?.code !== 11000) throw err;
        const holder = await locks().findOne({ projectId, key });
        return res.status(423).json({
          ok: false,
          holder: holder
            ? { holderId: holder.holderId, userName: holder.userName, since: holder.acquiredAt }
            : null,
        });
      }
    } catch (err) {
      console.error('❌ lock acquire:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Let go of one lock, or of every lock this tab holds (no key).
  app.post('/api/projects/:id/locks/release', async (req, res) => {
    const projectId = req.params.id;
    const holderId = clean(req.body?.holderId);
    const key = req.body?.key != null ? clean(req.body.key, 220) : null;
    if (!holderId) return res.status(400).json({ error: 'holderId is required' });
    try {
      await locks().deleteMany(key ? { projectId, key, holderId } : { projectId, holderId });
      res.json({ ok: true });
    } catch (err) {
      console.error('❌ lock release:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // "Still here": every lock this tab holds is kept alive, and the answer is
  // everybody's locks and the project's version.
  app.post('/api/projects/:id/locks/heartbeat', async (req, res) => {
    const projectId = req.params.id;
    const holderId = clean(req.body?.holderId);
    const userName = clean(req.body?.userName) || 'Someone';
    if (!holderId) return res.status(400).json({ error: 'holderId is required' });
    try {
      await ensureIndexes();
      const now = new Date();
      await locks().updateMany(
        { projectId, holderId, expiresAt: { $gt: now } },
        { $set: { expiresAt: new Date(now.getTime() + LOCK_TTL_MS), userName } },
      );
      res.json({ ok: true, locks: await active(projectId), rev: await projectRev(projectId), ttlMs: LOCK_TTL_MS });
    } catch (err) {
      console.error('❌ lock heartbeat:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}
