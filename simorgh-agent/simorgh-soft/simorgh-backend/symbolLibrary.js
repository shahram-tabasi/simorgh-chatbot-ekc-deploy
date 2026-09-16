// The office's own symbol library — its own database.
//
// A symbol somebody added used to live in `localStorage`: the browser's own
// cache, on one machine, erased by clearing site data and invisible to everyone
// else. That is an acceptable place for a filter setting and not for a library
// an office builds up over years.
//
// It lives here instead, and in a database of its own rather than among the
// projects. That is the point rather than tidiness: the library belongs to the
// office, not to any job. It outlives every project in it, it is the same
// library whichever project is open, and it can be dumped, restored, copied to
// another site or handed to a customer on its own — without carrying anybody's
// commercial drawings along with it. Projects come and go; the library is the
// thing the office keeps. `mongodump --uri --archive` takes every database on
// the server, so the nightly backup already has it.
//
// `id` is what a drawing refers to, so it is unique and never reassigned.
// Deleting a symbol does not reach into drawings that used it — a placed block
// carries its own geometry, as it always has.

/** Everything a symbol needs to be drawn and connected to. */
function clean(body) {
  const kind = ['sld', 'wd', 'old'].includes(String(body?.kind)) ? String(body.kind) : 'sld';
  const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);

  const terminals = Array.isArray(body?.terminals)
    ? body.terminals
      .filter(t => Number.isFinite(Number(t?.x)) && Number.isFinite(Number(t?.y)))
      .slice(0, 64)
      .map((t, i) => ({
        x: Number(t.x),
        y: Number(t.y),
        name: String(t.name ?? '').trim().slice(0, 16) || String(i + 1),
      }))
    : [];

  return {
    name: String(body?.name ?? '').trim().slice(0, 120),
    kind,
    group: String(body?.group ?? '').trim().slice(0, 80),
    art: String(body?.art ?? ''),
    width: num(body?.width, 20),
    height: num(body?.height, 20),
    terminals,
  };
}

/** The shape of a symbol going back out, with the stored id. */
const asSymbol = doc => ({
  id: doc.id,
  name: doc.name,
  kind: doc.kind,
  group: doc.group,
  art: doc.art,
  width: doc.width,
  height: doc.height,
  terminals: doc.terminals ?? [],
  changedOn: doc.changedOn,
});

/** What an exported library file says it is. */
const FORMAT = 'simorgh-draw-library';
const FORMAT_VERSION = 1;

export function registerSymbolLibraryRoutes(app, getDb, getProjectDb) {
  const symbols = () => getDb().collection('symbols');

  /** `id` is what drawings and the assistant name a symbol by, so it is unique. */
  async function ensureIndexes() {
    try {
      await symbols().createIndex({ id: 1 }, { unique: true });
    } catch (err) {
      console.error('[library] could not build the id index:', err.message);
    }
    await migrateFromProjectDb();
  }

  /**
   * Symbols saved before the library had a database of its own.
   *
   * They were written to `drawSymbols` in the projects database. Moved once,
   * on startup, and only into ids the library does not already have — so a
   * site that has since added a symbol under the same id keeps theirs, and
   * running this twice changes nothing. The old collection is left where it
   * is: a migration that deletes the only other copy of the data is a
   * migration you cannot check afterwards.
   */
  async function migrateFromProjectDb() {
    if (!getProjectDb) return;
    try {
      const old = getProjectDb().collection('drawSymbols');
      const docs = await old.find({}).toArray();
      if (docs.length === 0) return;
      let moved = 0;
      for (const doc of docs) {
        if (!doc?.id) continue;
        const r = await symbols().updateOne(
          { id: doc.id },
          { $setOnInsert: { ...doc, _id: undefined } },
          { upsert: true },
        );
        if (r.upsertedCount) moved += 1;
      }
      if (moved) console.log(`[library] moved ${moved} symbol(s) out of the projects database`);
    } catch (err) {
      console.error('[library] could not move the old symbols across:', err.message);
    }
  }

  app.get('/api/symbols', async (req, res) => {
    try {
      const docs = await symbols()
        .find({}).sort({ kind: 1, group: 1, name: 1 }).toArray();
      res.json({ symbols: docs.map(asSymbol) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/symbols/:id', async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'A symbol needs an id' });

    const body = clean(req.body);
    if (!body.name) return res.status(400).json({ error: 'A symbol needs a name' });
    if (!body.art) return res.status(400).json({ error: 'A symbol needs some geometry' });

    try {
      const now = new Date().toISOString();
      await symbols().updateOne(
        { id },
        { $set: { ...body, id, changedOn: now }, $setOnInsert: { createdOn: now } },
        { upsert: true },
      );
      const doc = await symbols().findOne({ id });
      res.json({ symbol: asSymbol(doc) });
    } catch (err) {
      // A duplicate id can only happen on a race, and the loser should see the
      // winner rather than an error it can do nothing about.
      if (err?.code === 11000) {
        const doc = await symbols().findOne({ id });
        if (doc) return res.json({ symbol: asSymbol(doc) });
      }
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/symbols/:id', async (req, res) => {
    const id = String(req.params.id || '').trim();
    try {
      const r = await symbols().deleteOne({ id });
      res.json({ deleted: r.deletedCount });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Taking the library somewhere else ───────────────────────────────────
  //
  // A file, because that is the only transport these sites have: the servers
  // are off the internet, and a library moves between them on a memory stick
  // the same way a drawing does. It is also what makes the library something
  // an office owns rather than something inside a server — it can be kept,
  // versioned, sent to a customer, or restored after the worst day.

  app.get('/api/library/export', async (req, res) => {
    try {
      const docs = await symbols()
        .find({}).sort({ kind: 1, group: 1, name: 1 }).toArray();
      res.json({
        format: FORMAT,
        version: FORMAT_VERSION,
        exportedOn: new Date().toISOString(),
        symbols: docs.map(asSymbol),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/library/import', async (req, res) => {
    const body = req.body || {};
    if (body.format !== FORMAT) {
      return res.status(400).json({
        error: 'This is not a Simorgh Draw library file.',
      });
    }
    if (!Array.isArray(body.symbols)) {
      return res.status(400).json({ error: 'The file carries no symbols.' });
    }
    // 'replace' is what somebody restoring a backup means; 'merge' is what
    // somebody taking another site's symbols means. Merge is the default,
    // because it is the one that cannot lose anything.
    const replace = body.mode === 'replace';

    try {
      const now = new Date().toISOString();
      let added = 0, updated = 0, skipped = 0;

      if (replace) {
        await symbols().deleteMany({});
      }

      for (const raw of body.symbols) {
        const id = String(raw?.id || '').trim();
        const doc = clean(raw);
        if (!id || !doc.name || !doc.art) { skipped += 1; continue; }
        const existing = replace ? null : await symbols().findOne({ id });
        await symbols().updateOne(
          { id },
          { $set: { ...doc, id, changedOn: now }, $setOnInsert: { createdOn: now } },
          { upsert: true },
        );
        if (existing) updated += 1; else added += 1;
      }

      res.json({ added, updated, skipped, replaced: replace });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return { ensureIndexes };
}
