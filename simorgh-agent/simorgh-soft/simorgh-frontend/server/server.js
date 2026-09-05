import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config(); // این خط رو اضافه کردیم!

const app = express();
const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = process.env.DATABASE_NAME || 'simorgh_db';

// Single source of truth for the revision-delete password. Change this
// value (or set REVISION_DELETE_PASSWORD in .env) to update it everywhere.
const REVISION_DELETE_PASSWORD = process.env.REVISION_DELETE_PASSWORD || '1234';

app.use(cors());
app.use(express.json());

let db;

async function connectToDatabase() {
  if (!MONGODB_URI) {
    console.error('MONGODB_URI در .env پیدا نشد!');
    process.exit(1);
  }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DATABASE_NAME);
    console.log('Connected to MongoDB successfully');
    console.log(`Database: ${DATABASE_NAME}`);
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error.message);
    process.exit(1);
  }
}

// --- همه روت‌ها همون قبلی ---
app.get('/api/projects', async (req, res) => {
  try {
    const projects = await db.collection('projects').find({}).toArray();
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// Get a single project by ID (required by the frontend's deep-link
// hydration and revision flows — was previously missing, causing
// "Failed to fetch project" errors)
app.get('/api/projects/:id', async (req, res) => {
  try {
    const project = await db.collection('projects').findOne({ _id: new ObjectId(req.params.id) });
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json(project);
  } catch (error) {
    console.error('Failed to fetch project:', error);
    res.status(500).json({ error: 'Failed to fetch project' });
  }
});

app.post('/api/projects', async (req, res) => {
  try {
    const projectData = { ...req.body, createdOn: new Date().toISOString(), changedOn: new Date().toISOString() };
    const result = await db.collection('projects').insertOne(projectData);
    res.status(201).json({ _id: result.insertedId, ...projectData });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create project' });
  }
});

app.put('/api/projects/:id', async (req, res) => {
  try {
    const result = await db.collection('projects').findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: { ...req.body, changedOn: new Date().toISOString() } },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update project' });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const count = await db.collection('projects').countDocuments();
    res.json({ status: 'OK', database: 'Connected', totalProjects: count });
  } catch (error) {
    res.status(500).json({ status: 'ERROR', database: 'Disconnected' });
  }
});

app.get('/', (req, res) => {
  res.json({ message: 'Simorgh Backend Server is running!' });
});

async function startServer() {
  await connectToDatabase();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Health: http://localhost:${PORT}/api/health`);
  });
}


// ============================================
// Revision Management APIs
// ============================================

// Get all revisions for a project
app.get('/api/projects/:projectId/revisions', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const revisions = await db.collection('revisions')
      .find({ projectId })
      .toArray();
    // revisionNumber is stored as a string, so sort numerically here
    // instead of relying on Mongo's lexicographic string sort (which
    // would order "10" before "2").
    revisions.sort((a, b) => (parseInt(b.revisionNumber, 10) || 0) - (parseInt(a.revisionNumber, 10) || 0));
    res.json(revisions);
  } catch (error) {
    console.error('Failed to fetch revisions:', error);
    res.status(500).json({ error: 'Failed to fetch revisions' });
  }
});

// Create a new revision
app.post('/api/revisions', async (req, res) => {
  try {
    const { projectId, revisionNumber, revisionName, description, createdBy, projectSnapshot, isLocked } = req.body;
    
    if (!projectId || revisionNumber === undefined) {
      return res.status(400).json({ error: 'projectId and revisionNumber are required' });
    }
    
    // Check for duplicate revision number
    const existing = await db.collection('revisions').findOne({ projectId, revisionNumber });
    if (existing) {
      return res.status(409).json({ error: `Revision ${revisionNumber} already exists for this project` });
    }
    
    const newRevision = {
      projectId,
      revisionNumber: revisionNumber.toString(),
      revisionName: revisionName || `Revision ${revisionNumber}`,
      description: description || '',
      createdBy: createdBy || 'system',
      projectSnapshot: projectSnapshot || null,
      isLocked: isLocked || false,
      createdOn: new Date().toISOString(),
      changedOn: new Date().toISOString()
    };
    
    const result = await db.collection('revisions').insertOne(newRevision);
    res.status(201).json({ _id: result.insertedId, ...newRevision });
  } catch (error) {
    console.error('Failed to create revision:', error);
    res.status(500).json({ error: 'Failed to create revision' });
  }
});

// Get a specific revision
app.get('/api/revisions/:revisionId', async (req, res) => {
  try {
    const revision = await db.collection('revisions').findOne({ _id: new ObjectId(req.params.revisionId) });
    if (!revision) {
      return res.status(404).json({ error: 'Revision not found' });
    }
    res.json(revision);
  } catch (error) {
    console.error('Failed to fetch revision:', error);
    res.status(500).json({ error: 'Failed to fetch revision' });
  }
});

// Update a revision (used to keep the active revision's snapshot in sync
// as the user keeps editing, and to rename/annotate it)
app.put('/api/revisions/:revisionId', async (req, res) => {
  try {
    const { revisionName, description, projectSnapshot, isLocked } = req.body;
    const update = { changedOn: new Date().toISOString() };
    if (revisionName !== undefined) update.revisionName = revisionName;
    if (description !== undefined) update.description = description;
    if (projectSnapshot !== undefined) update.projectSnapshot = projectSnapshot;
    if (isLocked !== undefined) update.isLocked = isLocked;

    const result = await db.collection('revisions').findOneAndUpdate(
      { _id: new ObjectId(req.params.revisionId) },
      { $set: update },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Revision not found' });
    res.json(result);
  } catch (error) {
    console.error('Failed to update revision:', error);
    res.status(500).json({ error: 'Failed to update revision' });
  }
});

// Delete a revision. Requires the delete password and enforces strict
// reverse-order deletion (only the current latest revision may be
// deleted), and a project must always keep at least one revision.
app.delete('/api/revisions/:revisionId', async (req, res) => {
  try {
    const { password } = req.body || {};
    if (password !== REVISION_DELETE_PASSWORD) {
      return res.status(403).json({ error: 'Incorrect password' });
    }

    const revision = await db.collection('revisions').findOne({ _id: new ObjectId(req.params.revisionId) });
    if (!revision) {
      return res.status(404).json({ error: 'Revision not found' });
    }

    const allRevisions = await db.collection('revisions')
      .find({ projectId: revision.projectId })
      .toArray();

    if (allRevisions.length <= 1) {
      return res.status(400).json({ error: 'Cannot delete the only remaining revision. A project must always have at least one revision.' });
    }

    const highestNumber = Math.max(...allRevisions.map(r => parseInt(r.revisionNumber, 10) || 0));
    const thisNumber = parseInt(revision.revisionNumber, 10) || 0;
    if (thisNumber !== highestNumber) {
      return res.status(400).json({ error: 'Only the latest revision can be deleted. Delete newer revisions first.' });
    }

    await db.collection('revisions').deleteOne({ _id: new ObjectId(req.params.revisionId) });
    res.json({ success: true, deletedId: req.params.revisionId });
  } catch (error) {
    console.error('Failed to delete revision:', error);
    res.status(500).json({ error: 'Failed to delete revision' });
  }
});

startServer();
