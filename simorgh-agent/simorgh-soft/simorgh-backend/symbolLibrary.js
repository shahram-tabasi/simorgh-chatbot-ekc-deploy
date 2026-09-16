// The office's own symbol library.
//
// Until now a symbol somebody added lived in `localStorage` — the browser's
// own cache, on one machine, erased by clearing site data and invisible to
// everyone else. That is an acceptable place for a filter setting. It is not
// an acceptable place for a library an office builds up over years: the second
// draughtsman never sees it, and the day the browser is cleared it is gone
// with no way back.
//
// So a symbol lives here, in the same Mongo the projects live in, which means
// it is in the nightly dump and in every backup already being taken. `id` is
// what a drawing refers to, so it is unique and never reassigned; deleting a
// symbol therefore does not reach into drawings that already used it — those
// carry their own geometry, as every placed block does.

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

export function registerSymbolLibraryRoutes(app, getDb) {
  /** `id` is what drawings and the assistant name a symbol by, so it is unique. */
  async function ensureIndexes() {
    try {
      await getDb().collection('drawSymbols').createIndex({ id: 1 }, { unique: true });
    } catch (err) {
      console.error('[symbols] could not build the id index:', err.message);
    }
  }

  app.get('/api/symbols', async (req, res) => {
    try {
      const docs = await getDb().collection('drawSymbols')
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
      await getDb().collection('drawSymbols').updateOne(
        { id },
        { $set: { ...body, id, changedOn: now }, $setOnInsert: { createdOn: now } },
        { upsert: true },
      );
      const doc = await getDb().collection('drawSymbols').findOne({ id });
      res.json({ symbol: asSymbol(doc) });
    } catch (err) {
      // A duplicate id can only happen on a race, and the loser should see the
      // winner rather than an error it can do nothing about.
      if (err?.code === 11000) {
        const doc = await getDb().collection('drawSymbols').findOne({ id });
        if (doc) return res.json({ symbol: asSymbol(doc) });
      }
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/symbols/:id', async (req, res) => {
    const id = String(req.params.id || '').trim();
    try {
      const r = await getDb().collection('drawSymbols').deleteOne({ id });
      res.json({ deleted: r.deletedCount });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return { ensureIndexes };
}
