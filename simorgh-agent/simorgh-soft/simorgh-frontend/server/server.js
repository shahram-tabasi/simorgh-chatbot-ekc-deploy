import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config(); // این خط رو اضافه کردیم!

const app = express();
const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = process.env.DATABASE_NAME || 'simorgh_db';

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
      .sort({ revisionNumber: -1 })
      .toArray();
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

startServer();
