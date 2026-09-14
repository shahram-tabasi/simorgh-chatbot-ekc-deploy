// Project documents — the Documents tab.
//
// Files live in MongoDB GridFS (the same Mongo this app already runs and
// backs up — no second storage system to stand up or remember to back up
// separately); one `documents` collection holds the metadata each file
// carries: which project and category it belongs to, who uploaded it, its
// extracted text (so the chatbot can read it without a re-upload — see
// list_project_documents / read_project_document in chatbotTools.ts), and
// the comments and highlights left on it.
import { GridFSBucket, ObjectId } from 'mongodb';
import multer from 'multer';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { extractPdfText } from './pdfText.js';

export const DOCUMENT_CATEGORIES = [
  'SPEC', 'SLD-OLD', 'Site Layout', 'Logic', 'Load List', 'Io List',
  'Data sheet', 'Cover', 'Other',
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const TEXT_MAX_CHARS = Number(process.env.DOCUMENT_TEXT_MAX_CHARS || 25000);
const clip = text => (text.length > TEXT_MAX_CHARS ? `${text.slice(0, TEXT_MAX_CHARS)}\n…[truncated]…` : text);

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Best-effort plain text for the AI to read — empty for anything (images,
 *  legacy .doc/.xls, a corrupt file) this can't pull text out of. Never
 *  throws: a document that can't be read still gets stored, just without
 *  extractedText. */
async function extractText(buffer, mimeType, filename) {
  try {
    if (mimeType === 'application/pdf') {
      const parsed = await extractPdfText(buffer, filename);
      return parsed?.text || '';
    }
    if (mimeType === DOCX_MIME) {
      const result = await mammoth.extractRawText({ buffer });
      return clip((result.value || '').trim());
    }
    if (mimeType === XLSX_MIME) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer);
      const parts = [];
      wb.eachSheet(sheet => {
        parts.push(`# ${sheet.name}`);
        sheet.eachRow(row => {
          const cells = (row.values || []).slice(1)
            .map(v => (v == null ? '' : String(v))).filter(Boolean);
          if (cells.length) parts.push(cells.join('\t'));
        });
      });
      return clip(parts.join('\n'));
    }
    return '';
  } catch (err) {
    console.error(`Document text extraction failed for ${filename}:`, err.message);
    return '';
  }
}

/**
 * @param app        the Express app
 * @param getDb      () => Db — a getter, not the Db itself: routes are
 *                   registered before connectToDatabase() resolves, so the
 *                   module-level `db` in server.js isn't assigned yet at
 *                   registration time, only once a request actually arrives.
 */
export function registerDocumentRoutes(app, getDb) {
  const bucketFor = db => new GridFSBucket(db, { bucketName: 'documents' });

  app.get('/api/documents/categories', (req, res) => {
    res.json({ categories: DOCUMENT_CATEGORIES });
  });

  // List for a project — extractedText left out, it can be large and the
  // list view never shows it; fetch one document's own record for that.
  app.get('/api/documents', async (req, res) => {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });
    try {
      const db = getDb();
      const docs = await db.collection('documents')
        .find({ projectId: String(projectId) }, { projection: { extractedText: 0 } })
        .sort({ category: 1, uploadedAt: -1 })
        .toArray();
      res.json({ documents: docs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/documents/:id', async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    try {
      const db = getDb();
      const doc = await db.collection('documents').findOne({ _id: new ObjectId(req.params.id) });
      if (!doc) return res.status(404).json({ error: 'Not found' });
      res.json(doc);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // The raw bytes, for the viewer (PDF.js, <img>) or a plain download.
  app.get('/api/documents/:id/file', async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).send('Invalid id');
    try {
      const db = getDb();
      const doc = await db.collection('documents').findOne({ _id: new ObjectId(req.params.id) });
      if (!doc) return res.status(404).send('Not found');
      res.set('Content-Type', doc.mimeType || 'application/octet-stream');
      res.set('Content-Disposition', `inline; filename="${encodeURIComponent(doc.filename)}"`);
      const bucket = bucketFor(db);
      bucket.openDownloadStream(new ObjectId(doc.gridfsId))
        .on('error', () => { if (!res.headersSent) res.status(404).end(); })
        .pipe(res);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/documents/upload', upload.single('file'), async (req, res) => {
    const { projectId, category, uploadedBy } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });
    if (!DOCUMENT_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${DOCUMENT_CATEGORIES.join(', ')}` });
    }
    try {
      const db = getDb();
      const bucket = bucketFor(db);
      const gridfsId = await new Promise((resolve, reject) => {
        const stream = bucket.openUploadStream(file.originalname, { contentType: file.mimetype });
        stream.on('error', reject);
        stream.on('finish', () => resolve(stream.id));
        stream.end(file.buffer);
      });

      const extractedText = await extractText(file.buffer, file.mimetype, file.originalname);

      const doc = {
        projectId: String(projectId),
        category,
        filename: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        uploadedBy: uploadedBy || 'unknown',
        uploadedAt: new Date().toISOString(),
        gridfsId: gridfsId.toString(),
        extractedText,
        comments: [],
        highlights: [],
      };
      const result = await db.collection('documents').insertOne(doc);
      res.json({ ...doc, _id: result.insertedId });
    } catch (err) {
      console.error('Document upload error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Comments and highlights, saved together — the viewer sends its whole
  // annotation state back each time rather than diffing individual entries,
  // since both lists are small per document and this keeps the save path
  // (and the conflict story: last save wins) simple.
  app.put('/api/documents/:id/annotations', async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const { comments, highlights } = req.body || {};
    const update = {};
    if (Array.isArray(comments)) update.comments = comments;
    if (Array.isArray(highlights)) update.highlights = highlights;
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'comments and/or highlights array required' });
    }
    try {
      const db = getDb();
      await db.collection('documents').updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: update },
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/documents/:id', async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    try {
      const db = getDb();
      const doc = await db.collection('documents').findOne({ _id: new ObjectId(req.params.id) });
      if (!doc) return res.status(404).json({ error: 'Not found' });
      const bucket = bucketFor(db);
      if (doc.gridfsId && ObjectId.isValid(doc.gridfsId)) {
        await bucket.delete(new ObjectId(doc.gridfsId)).catch(() => {});
      }
      await db.collection('documents').deleteOne({ _id: new ObjectId(req.params.id) });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
