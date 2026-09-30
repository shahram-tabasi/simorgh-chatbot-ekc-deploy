// Plotframe "User supplementary field" values for the Send to EPLAN tab —
// the same per-project/scope/drawing-type values Eplanix's own ProjectData
// screen keeps (indices 1-9, 11-19, 21-29, 31-39, 41-49, 50-70, 91-94; see
// PlotframeFieldIndexes in Eplanix's EplanixController.cs), but stored here
// in this app's own Mongo rather than Eplanix's SQL Server — this backend
// has no access to that database, only to eplan-bridge's /draw endpoint.
//
// Field index set the form exposes, in order: 1-9, 11-19, 21-29, 31-39,
// 41-49 (the five "User supplementary field" subsets), 50-70 (Options),
// plus 91-94 (Origin / Replacement of / Replaced by / Macro version).
export const PLOTFRAME_FIELD_INDEXES = [
  ...Array.from({ length: 5 }, (_, b) => Array.from({ length: 9 }, (_, j) => b * 10 + j + 1)).flat(),
  ...Array.from({ length: 21 }, (_, i) => 50 + i),
  91, 92, 93, 94,
];

const normalizeDrawingType = t => (String(t || '').toUpperCase() === 'OLD' ? 'OLD' : 'SLD');

export function registerPlotframeFieldRoutes(app, getDb) {
  app.get('/api/eplan/plotframe-fields', async (req, res) => {
    const { projectId, equipmentId } = req.query;
    const drawingType = normalizeDrawingType(req.query.drawingType);
    if (!projectId || !equipmentId) {
      return res.status(400).json({ error: 'projectId and equipmentId are required' });
    }
    try {
      const db = getDb();
      const doc = await db.collection('eplanPlotframeFields').findOne({
        projectId: String(projectId), equipmentId: String(equipmentId), drawingType,
      });
      res.json({ fields: doc?.fields || {} });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/eplan/plotframe-fields', async (req, res) => {
    const { projectId, equipmentId, fields } = req.body || {};
    const drawingType = normalizeDrawingType(req.body?.drawingType);
    if (!projectId || !equipmentId || typeof fields !== 'object' || fields === null) {
      return res.status(400).json({ error: 'projectId, equipmentId and a fields object are required' });
    }
    // Only the known indices are kept — anything else in the payload is ignored.
    const clean = {};
    for (const i of PLOTFRAME_FIELD_INDEXES) {
      const key = String(i);
      if (fields[key] !== undefined) clean[key] = String(fields[key]);
    }
    try {
      const db = getDb();
      await db.collection('eplanPlotframeFields').updateOne(
        { projectId: String(projectId), equipmentId: String(equipmentId), drawingType },
        { $set: { fields: clean, updatedAt: new Date().toISOString() } },
        { upsert: true },
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
