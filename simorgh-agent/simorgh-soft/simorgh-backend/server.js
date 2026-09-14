// server.js - نسخه نهایی با فیلتر سازنده و اتصال SQL + MySQL
import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import cors from 'cors';
import dotenv from 'dotenv';
import sql from 'mssql';
import mysql from 'mysql2/promise';
import multer from 'multer';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerDesktopRoutes } from './desktopDownload.js';
import { registerTpmsImportRoutes } from './tpmsImport.js';
import { deadline, MYSQL_PING_TIMEOUT_MS } from './dbTimeout.js';
import { registerEplanSymbolRoutes } from './eplanSymbols.js';
import { registerEplanRoutes } from './eplanSend.js';
import { registerDrawAssistRoutes } from './drawAssist.js';
import { registerDocumentRoutes } from './documents.js';
import { registerPlotframeFieldRoutes } from './plotframeFields.js';
import { extractPdfText } from './pdfText.js';
import {
  buildSystemPrompt, extractToolEnvelope, callLocalModel,
  DEFAULT_LOCAL_MODEL_URL, DEFAULT_LOCAL_MODEL_NAME,
} from './chatModel.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = process.env.DATABASE_NAME || 'simorgh_db';

app.use(cors());
// A project's snapshot is the whole project — for a switchgear plant with a
// dozen panels that is megabytes, and express.json()'s default 100 KB was
// rejecting every save of one with 413 "entity.too.large". Reads were fine,
// which is exactly why a big project appeared to open and then never landed.
// The EPLAN payload (one record per feeder) needs the same headroom.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '100mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.JSON_BODY_LIMIT || '100mb' }));

let db;

// ============================================
// MongoDB Connection (existing)
// ============================================
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

// ============================================
// SQL Server Connection (ADDED - from server-example.js)
// ============================================
// SQL Server configuration for EPLAN database (READ-ONLY access)
const sqlConfig = {
  user: process.env.SQL_USER || 'userfanni',
  password: process.env.SQL_PASSWORD || '12345678',
  server: process.env.SQL_SERVER || '192.168.1.39',
  database: process.env.SQL_DATABASE || 'Eplan_n2',
  port: parseInt(process.env.SQL_PORT) || 1433,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    connectTimeout: 30000,
    requestTimeout: 60000   // افزایش به 60 ثانیه برای جداول بزرگ
  },
  pool: {
    max: 5,
    min: 0,
    idleTimeoutMillis: 30000,
    acquireTimeoutMillis: 30000
  }
};

let sqlPool = null;

async function connectToSqlServer() {
  // Reuse existing pool if available
  if (sqlPool) return sqlPool;

  console.log("🔄 Connecting to SQL Server (EPLAN)...");
  const pool = new sql.ConnectionPool(sqlConfig);

  // On pool-level error, clear the reference so the next request reconnects
  pool.on('error', (err) => {
    console.error('❌ SQL Pool error:', err.message);
    sqlPool = null;
  });

  // IMPORTANT: assign sqlPool ONLY after connect() succeeds.
  // Assigning before connect() causes concurrent requests to see an
  // unconnected pool and try to close/recreate it (race condition).
  await pool.connect();
  sqlPool = pool;
  console.log("✅ Connected to SQL Server (EPLAN) successfully!");
  return sqlPool;
}

// ============================================
// MySQL Connection (TPMS Database - READ-ONLY)
// ============================================
const mysqlConfig = {
  host: process.env.MYSQL_HOST || '192.168.1.148',
  port: parseInt(process.env.MYSQL_PORT) || 3306,
  database: process.env.MYSQL_DATABASE || 'TPMS',
  user: process.env.MYSQL_USER || 'technical',
  password: process.env.MYSQL_PASSWORD || 'HoJETA',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 30000,
  // The TPMS host is on another subnet, reached from inside the container
  // network, so an idle pooled socket can be dropped in transit by a firewall
  // or NAT table without either end being told. mysql2 then hands that dead
  // socket to the next request, which writes its query into a black hole and
  // only gives up on the query timeout — every TPMS call failing after
  // exactly TPMS_QUERY_TIMEOUT_MS while the pool still believes it is
  // connected. Keepalive probes start after 10s of quiet and hold the flow
  // open; mysql2's own default delay is the OS one (2 hours on Linux), which
  // is far longer than the idle timeout of anything in the path.
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  // And retire sockets that went quiet anyway, rather than letting them sit
  // in the pool until a request trips over them.
  maxIdle: 4,
  idleTimeout: 60000,
};

let mysqlPool;

// Connect to MySQL (READ-ONLY)
async function connectToMySql() {
  try {
    if (!mysqlPool) {
      console.log("🔄 Connecting to MySQL (TPMS)...");
      const pool = mysql.createPool(mysqlConfig);
      // Without this, a fatal out-of-band pool error (TPMS host reset, a
      // MySQL restart) is an unhandled 'error' event — Node crashes the
      // whole process, not just the TPMS request in flight. Same fix as
      // sqlPool's handler above.
      pool.on('error', (err) => {
        console.error('❌ MySQL Pool error:', err.message);
        mysqlPool = null;
      });
      // Test connection
      const connection = await pool.getConnection();
      connection.release();
      mysqlPool = pool;
      console.log("✅ Connected to MySQL (TPMS) successfully!");
    }
    return mysqlPool;
  } catch (err) {
    console.error("❌ MySQL connection error:", err.message);
    mysqlPool = null;
    throw err;
  }
}

// ============================================
// SQL Health Check
// ============================================
app.get('/api/sql-health', async (req, res) => {
  try {
    const pool = await connectToSqlServer();
    const result = await pool.request().query('SELECT 1 AS ok, @@VERSION AS version');
    res.json({ connected: true, version: result.recordset[0].version });
  } catch (err) {
    res.status(500).json({ connected: false, error: err.message });
  }
});

// ============================================
// Existing Routes (unchanged)
// ============================================
app.get('/api/projects', async (req, res) => {
  try {
    const projects = await db.collection('projects').find({}).toArray();
    res.json(projects);
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// Search projects by name or description
app.get('/api/projects/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res.json([]);
    }
    const projects = await db.collection('projects')
      .find({
        $or: [
          { projectName: { $regex: q, $options: 'i' } },
          { projectDescription: { $regex: q, $options: 'i' } }
        ]
      })
      .toArray();
    res.json(projects);
  } catch (error) {
    console.error('Error searching projects:', error);
    res.status(500).json({ error: 'Failed to search projects' });
  }
});

// Get project by exact name
app.get('/api/projects/name/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const project = await db.collection('projects').findOne({ 
      projectName: { $regex: new RegExp('^' + name + '$', 'i') } 
    });
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json(project);
  } catch (error) {
    console.error('Error fetching project by name:', error);
    res.status(500).json({ error: 'Failed to fetch project by name' });
  }
});

// Get one project by its _id. Declared after /search and /name/:name so those
// literal paths keep matching first — this one only catches real ids.
app.get('/api/projects/:id', async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(404).json({ error: 'Project not found' });
  }
  try {
    const project = await db.collection('projects').findOne({ _id: new ObjectId(id) });
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json(project);
  } catch (error) {
    console.error('Error fetching project by id:', error);
    res.status(500).json({ error: 'Failed to fetch project' });
  }
});

app.post('/api/projects', async (req, res) => {
  try {
    // Check if project with same name already exists
    const existing = await db.collection('projects').findOne({
      projectName: { $regex: new RegExp('^' + req.body.projectName + '$', 'i') }
    });
    
    if (existing) {
      return res.status(409).json({ error: 'Project with this name already exists' });
    }
    
    const projectData = { ...req.body, createdOn: new Date().toISOString(), changedOn: new Date().toISOString() };
    const result = await db.collection('projects').insertOne(projectData);
    res.status(201).json({ _id: result.insertedId, ...projectData });
  } catch (error) {
    console.error('Error creating project:', error);
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

// Windows desktop client — the installer drop folder and its two routes.
registerDesktopRoutes(app);

// TPMS import — the same MySQL reads Eplanix does, mapped for this app.
registerTpmsImportRoutes(app, connectToMySql);

// EPLAN symbols — the single-line symbol each part carries in EPLAN's parts
// database, plus the folder of symbols exported from EPLAN itself.
registerEplanSymbolRoutes(app, connectToSqlServer, process.env.EPLAN_SYMBOL_DIR);

// EPLAN — forwards to eplan-bridge-service; address in .env (EPLAN_BRIDGE_URL).
registerEplanRoutes(app);

// Simorgh Draw's assistant: the local model writes shapes, this validates them
// before any of it reaches a sheet. Same model the chat uses — one endpoint to
// configure, not two.
registerDrawAssistRoutes(app, callLocalModel);

// Project documents — the Documents tab. A getter, not `db` itself: this
// registration runs before connectToDatabase() resolves (see startServer
// below), so `db` isn't assigned yet at this exact line — only by the time
// a request actually arrives.
registerDocumentRoutes(app, () => db);
registerPlotframeFieldRoutes(app, () => db);

app.get('/api/health', async (req, res) => {
  try {
    const count = await db.collection('projects').countDocuments();

    // Check SQL Server connection status
    let sqlStatus = 'disconnected';
    if (sqlPool) {
      try {
        await sqlPool.request().query('SELECT 1 AS test');
        sqlStatus = 'connected';
      } catch (err) {
        sqlStatus = 'error';
      }
    }

    // Check MySQL connection status.
    //
    // ping(), not getConnection() alone: taking a connection out of the pool
    // touches no network at all when an idle one is waiting, so a socket the
    // firewall dropped hours ago still reported 'connected' here while every
    // TPMS route 500'd on the query timeout. A ping is an actual round-trip,
    // so it can tell the difference — under a deadline, because the whole
    // point is that a dead socket answers nothing, and this endpoint is what
    // the container healthcheck calls: it has to fail fast, not hang.
    let mysqlStatus = 'disconnected';
    if (mysqlPool) {
      let conn = null;
      try {
        conn = await deadline(mysqlPool.getConnection(), MYSQL_PING_TIMEOUT_MS, 'MySQL getConnection');
        await deadline(conn.ping(), MYSQL_PING_TIMEOUT_MS, 'MySQL ping');
        mysqlStatus = 'connected';
        conn.release();
        conn = null;
      } catch (err) {
        mysqlStatus = 'error';
        // Destroy rather than release: a socket that will not answer a ping
        // must not go back in the pool for the next request to trip over.
        if (conn) { try { conn.destroy(); } catch { /* already gone */ } }
      }
    }

    res.json({
      status: 'OK',
      database: 'Connected',
      totalProjects: count,
      sqlServer: sqlStatus,
      mysql: mysqlStatus
    });
  } catch (error) {
    res.status(500).json({ status: 'ERROR', database: 'Disconnected', error: error.message });
  }
});

app.get('/', (req, res) => {
  res.json({ message: 'Simorgh Backend Server is running!' });
});

// ============================================
// TPMS MySQL API - Project pickers (READ-ONLY)
// Based on Eplanix's ProjectData / GetScopes / GetRevisions
// ============================================
//
// All three routes exist. They live in tpmsImport.js and are registered above
// by registerTpmsImportRoutes(app, connectToMySql) — they are not repeated
// here, because Express matches in registration order and a second copy at
// this point in the file would be dead code the first one always shadows.
//
//   GET /api/tpms/projects            -> SQL.projectList   (tpmsImport.js)
//   GET /api/tpms/scopes/:projectId   -> SQL.scopeList
//   GET /api/tpms/revisions/:scopeId  -> SQL.revisionList
//
// Each answers { success, count, items: [{ value, text }] }. The project list
// also carries `code` (OENUM) and `name` on their own, because the picker
// shows them as two columns; the C# joins the same two fields early instead,
// into one SelectListItem text (Oenum + ProjectName).
//
// The queries are the reads the C# makes, against the same MySQL views:
// View_Project_Main for the projects, and View_draft for the scopes
// (Tablo_ID/scopeName) and revisions of one.
//
// One part of C# GetScopes has no equivalent here, deliberately: the check
// that the caller holds write access to \\techserver\OE<nnn> before the
// scopes are handed over. It reads a Windows ACL and matches it against
// EKC\<User.Identity.Name>, and this backend has no authentication at all —
// there is no user to check, so the gate would be a no-op dressed as a
// control. If this API is ever reachable from outside the internal network,
// it needs to come back with a real identity behind it.

// ============================================
// ADDED: SQL Parts API with Manufacturer Filter
// Based on server-example.js (READ-ONLY queries only)
// ============================================

// Helper to strip junk characters (e.g. ??_??@ encoding artefacts) from SQL text fields.
// IMPORTANT: This function is applied ONLY in the HTTP response transformation layer
// (inside transformPartToFrontend, which runs after SELECT results are received).
// It does NOT issue any SQL commands and does NOT modify the SQL database in any way.
// The SQL database is READ-ONLY from this application's perspective.
function cleanText(str) {
  if (str == null) return '';
  // Some tblPart columns are numeric types in the schema; coerce to string before cleaning.
  // (e.g. numeric columns, Buffer objects). This prevents TypeError from breaking the
  // entire response when a non-string value appears in a text-mapped field.
  const s = typeof str === 'string' ? str : String(str);
  return s
    .replace(/\?\?_\?\?@/g, '')   // remove specific SQL encoding artefact pattern
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // remove control characters
    .trim();
}

// Helper function to transform SQL field names to frontend PascalCase format.
// Called AFTER data is fetched (read-only SELECT) — never before or during a write.
function transformPartToFrontend(part) {
  return {
    PartNumber: cleanText(part.partnr),
    TypeNumber: cleanText(part.typenr),
    OrderNumber: cleanText(part.ordernr),
    Manufacturer: cleanText(part.manufacturer),
    Designation1: cleanText(part.description1),
    Designation2: cleanText(part.description2),
    Designation3: cleanText(part.description3),
    ProductGroup: cleanText(part.productgroup),
    ProductSubgroup: cleanText(part.productsubgroup),
    Width: part.width,
    Height: part.height,
    Depth: part.depth,
    Weight: part.weight,
    MountingLocation: cleanText(part.mountinglocation),
    MountingSpace: cleanText(part.mountingspace),
    CertificateCE: part.certificate_CE,
    CertificateUL: part.certificate_UL,
    CertificateATEX: part.certificate_ATEX,
  };
}

/**
 * POST /api/eplan-parts - Fetch parts from EPLAN SQL (Frontend compatible endpoint)
 * This endpoint matches what the frontend TemplateProperties.tsx expects
 * Request body: { searchTerm?: string, manufacturer?: string, page?: number, pageSize?: number }
 * (READ-ONLY: SELECT queries only)
 * - page: Page number starting from 1 (default: 1)
 * - pageSize: Number of records per page (default: 100, max: 500)
 */
app.post('/api/eplan-parts', async (req, res) => {
  console.log('📥 POST /api/eplan-parts - Request received (frontend compatible)');

  try {
    const sqlDb = await connectToSqlServer();

    const { searchTerm = '', manufacturer = '', page = 1, pageSize = 100 } = req.body;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const pageSizeNum = Math.min(500, Math.max(1, parseInt(pageSize) || 100));
    const offset = (pageNum - 1) * pageSizeNum;

    console.log('📊 Parameters:', { searchTerm, manufacturer, pageNum, pageSizeNum, offset });

    // Build WHERE conditions (READ-ONLY: SELECT queries only)
    let where = [];
    let params = {};

    // Search filter
    if (searchTerm) {
      const searchPattern = `%${searchTerm}%`;
      where.push(`(
        partnr LIKE @search OR
        typenr LIKE @search OR
        ordernr LIKE @search OR
        description1 LIKE @search OR
        description2 LIKE @search OR
        description3 LIKE @search OR
        manufacturer LIKE @search OR
        productgroup LIKE @search
      )`);
      params.search = searchPattern;
    }

    // Manufacturer filter
    if (manufacturer) {
      where.push(`manufacturer = @man`);
      params.man = manufacturer;
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // Count query — use NOLOCK to avoid lock contention on large tables
    // Wrapped in try-catch so a slow COUNT never breaks the data response
    let total = 0;
    let totalPages = 1;
    try {
      const countRequest = sqlDb.request();
      Object.keys(params).forEach(key => {
        countRequest.input(key, sql.NVarChar, params[key]);
      });
      const countResult = await countRequest.query(
        `SELECT COUNT(*) AS total FROM tblPart WITH (NOLOCK) ${whereClause}`
      );
      total = countResult.recordset[0].total;
      totalPages = Math.ceil(total / pageSizeNum) || 1;
      console.log(`📈 Total matching records: ${total}`);
    } catch (countErr) {
      console.warn('⚠️ COUNT query skipped:', countErr.message);
      total = -1; // unknown
      totalPages = 999;
    }

    // Data query with pagination — SELECT * to avoid "Invalid column name" errors
    // on older SQL Server schemas that may not have all expected columns.
    const dataRequest = sqlDb.request();
    Object.keys(params).forEach(key => {
      dataRequest.input(key, sql.NVarChar, params[key]);
    });

    const rowStart = offset + 1;
    const rowEnd = offset + pageSizeNum;

    const dataQuery = `
      SELECT *
      FROM (
        SELECT *, ROW_NUMBER() OVER (ORDER BY partnr) AS RowNum
        FROM tblPart WITH (NOLOCK)
        ${whereClause}
      ) AS NumberedRows
      WHERE RowNum >= ${rowStart} AND RowNum <= ${rowEnd}
    `;

    const dataResult = await dataRequest.query(dataQuery);
    console.log(`📦 Records received: ${dataResult.recordset.length}`);
    if (dataResult.recordset.length === 0) {
      console.warn(`⚠️ 0 rows returned. Query: rowStart=${rowStart}, rowEnd=${rowEnd}, where="${whereClause}"`);
    }

    // Transform to frontend format (PascalCase field names).
    // cleanText() runs here, in-memory, after the SELECT result is received.
    // No SQL writes occur — the SQL database is never modified.
    const transformedData = dataResult.recordset.map(transformPartToFrontend);

    // Get manufacturers list (READ-ONLY) - only on first page to save time
    // Uses NOLOCK to avoid lock contention; wrapped in try-catch to prevent timeout breaking the response
    let manufacturers = [];
    if (pageNum === 1) {
      try {
        const manRequest = sqlDb.request();
        const manQuery = `
          SELECT DISTINCT manufacturer
          FROM tblPart WITH (NOLOCK)
          WHERE manufacturer IS NOT NULL AND manufacturer != ''
          ORDER BY manufacturer
        `;
        const manResult = await manRequest.query(manQuery);
        manufacturers = manResult.recordset.map(r => r.manufacturer);
      } catch (manErr) {
        console.warn('⚠️ Manufacturers query skipped:', manErr.message);
      }
    }

    res.json({
      success: true,
      data: transformedData,
      manufacturers: manufacturers,
      total: total,
      page: pageNum,
      pageSize: pageSizeNum,
      totalPages: totalPages
    });

  } catch (err) {
    console.error("❌ Error in POST /api/eplan-parts:", err.message);
    // Reset pool on connection errors so the next request triggers a fresh connect
    if (err.code === 'ECONNRESET' || err.code === 'ETIMEOUT' ||
        err.code === 'ENOTOPEN'   || err.code === 'ECONNREFUSED' ||
        err.name === 'ConnectionError' || err.name === 'RequestError') {
      console.warn('⚠️ Resetting SQL pool due to connection error, will reconnect on next request');
      sqlPool = null;
    }
    res.status(500).json({
      success: false,
      error: err.message,
      data: []
    });
  }
});

/**
 * POST /api/save-part-to-mongo - Save selected part to MongoDB
 * This endpoint matches what the frontend TemplateProperties.tsx expects
 * Request body: { partData, propertyName, templateId, timestamp }
 */
app.post('/api/save-part-to-mongo', async (req, res) => {
  console.log('📥 POST /api/save-part-to-mongo - Request received');

  try {
    const { partData, propertyName, templateId, timestamp } = req.body;

    if (!partData) {
      return res.status(400).json({
        success: false,
        error: 'Missing partData in request body'
      });
    }

    console.log(`📝 Saving part ${partData.PartNumber} for property ${propertyName}`);

    // Save to MongoDB selected_parts collection
    const selectedPartsCollection = db.collection('selected_parts');

    // Delete previous part for this property/template combination (replace behavior)
    await selectedPartsCollection.deleteOne({
      templateId: templateId,
      propertyName: propertyName
    });

    // Insert the new part
    const partDocument = {
      templateId: templateId,
      propertyName: propertyName,
      partData: partData,
      selectedAt: timestamp || new Date().toISOString()
    };

    await selectedPartsCollection.insertOne(partDocument);
    console.log('✅ Part saved to MongoDB');

    res.json({
      success: true,
      message: 'Part saved successfully',
      data: partDocument
    });

  } catch (err) {
    console.error("❌ Error in POST /api/save-part-to-mongo:", err.message);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/parts - Fetch parts from EPLAN SQL database with filtering
 * Query params:
 *   - search: Search term for part fields
 *   - man: Manufacturer filter (exact match)
 *   - offset: Pagination offset (default 0)
 */
app.get('/api/parts', async (req, res) => {
  console.log('📥 GET /api/parts - Request received');

  try {
    const sqlDb = await connectToSqlServer();

    let { search = '', man = '', offset = 0 } = req.query;
    offset = parseInt(offset) || 0;
    const limit = 50;

    console.log('📊 Parameters:', { search, man, offset, limit });

    // Build WHERE conditions (READ-ONLY: SELECT queries only)
    let where = [];
    let params = {};

    // Search filter: searches across multiple fields
    if (search) {
      const searchPattern = `%${search}%`;
      where.push(`(
        partnr LIKE @search OR
        typenr LIKE @search OR
        ordernr LIKE @search OR
        description1 LIKE @search OR
        description2 LIKE @search OR
        description3 LIKE @search OR
        manufacturer LIKE @search OR
        productgroup LIKE @search
      )`);
      params.search = searchPattern;
    }

    // ADDED: Manufacturer filter (exact match)
    if (man) {
      where.push(`manufacturer = @man`);
      params.man = man;
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    console.log('🔍 WHERE:', whereClause);

    // Count query with separate request (READ-ONLY)
    const countRequest = sqlDb.request();
    Object.keys(params).forEach(key => {
      countRequest.input(key, sql.NVarChar, params[key]);
    });

    const countQuery = `SELECT COUNT(*) AS total FROM tblPart ${whereClause}`;
    const countResult = await countRequest.query(countQuery);
    const total = countResult.recordset[0].total;
    console.log(`📈 Total count: ${total}`);

    // Data query with separate request (READ-ONLY)
    const dataRequest = sqlDb.request();
    Object.keys(params).forEach(key => {
      dataRequest.input(key, sql.NVarChar, params[key]);
    });

    const dataQuery = `
      SELECT
        partnr, typenr, ordernr, manufacturer,
        description1, description2, description3,
        productgroup, productsubgroup,
        width, height, depth, weight,
        mountinglocation, mountingspace,
        certificate_CE, certificate_UL, certificate_ATEX
      FROM (
        SELECT
          *,
          ROW_NUMBER() OVER (ORDER BY partnr) AS RowNum
        FROM tblPart
        ${whereClause}
      ) AS NumberedRows
      WHERE RowNum > ${offset} AND RowNum <= ${offset + limit}
      ORDER BY partnr
    `;

    const dataResult = await dataRequest.query(dataQuery);
    console.log(`📦 Records received: ${dataResult.recordset.length}`);

    // Get manufacturers list on first request (offset === 0) (READ-ONLY)
    let manufacturers = null;
    if (offset === 0) {
      const manRequest = sqlDb.request();
      const manQuery = `
        SELECT DISTINCT manufacturer
        FROM tblPart
        WHERE manufacturer IS NOT NULL AND manufacturer != ''
        ORDER BY manufacturer
      `;
      const manResult = await manRequest.query(manQuery);
      manufacturers = manResult.recordset.map(r => r.manufacturer);
      console.log(`🏭 Manufacturers count: ${manufacturers.length}`);
    }

    const response = {
      success: true,
      total: total,
      data: dataResult.recordset || [],
      manufacturers: manufacturers
    };

    res.json(response);

  } catch (err) {
    console.error("❌ Error in /api/parts:", err.message);
    console.error(err.stack);
    res.status(500).json({
      success: false,
      error: err.message,
      hint: 'Check server logs for details'
    });
  }
});

/**
 * GET /api/manufacturers - Get list of all manufacturers from EPLAN
 * (READ-ONLY: SELECT query only)
 */
app.get('/api/manufacturers', async (req, res) => {
  console.log('📥 GET /api/manufacturers - Request received');

  try {
    const sqlDb = await connectToSqlServer();

    const manRequest = sqlDb.request();
    const manQuery = `
      SELECT DISTINCT manufacturer
      FROM tblPart
      WHERE manufacturer IS NOT NULL AND manufacturer != ''
      ORDER BY manufacturer
    `;
    const manResult = await manRequest.query(manQuery);
    const manufacturers = manResult.recordset.map(r => r.manufacturer);

    console.log(`🏭 Manufacturers count: ${manufacturers.length}`);

    res.json({
      success: true,
      count: manufacturers.length,
      manufacturers: manufacturers
    });

  } catch (err) {
    console.error("❌ Error in /api/manufacturers:", err.message);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/parts/:partnr - Get a single part by part number (full object)
 * (READ-ONLY: SELECT query only)
 */
app.get('/api/parts/:partnr', async (req, res) => {
  console.log('📥 GET /api/parts/:partnr - Request received');

  try {
    const sqlDb = await connectToSqlServer();
    const { partnr } = req.params;

    const partRequest = sqlDb.request();
    partRequest.input('partnr', sql.NVarChar, partnr);

    const partQuery = `
      SELECT
        partnr, typenr, ordernr, manufacturer,
        description1, description2, description3,
        productgroup, productsubgroup,
        width, height, depth, weight,
        mountinglocation, mountingspace,
        certificate_CE, certificate_UL, certificate_ATEX
      FROM tblPart
      WHERE partnr = @partnr
    `;

    const partResult = await partRequest.query(partQuery);

    if (partResult.recordset.length === 0) {
      return res.status(404).json({ success: false, error: 'Part not found' });
    }

    res.json({
      success: true,
      data: partResult.recordset[0]
    });

  } catch (err) {
    console.error("❌ Error in /api/parts/:partnr:", err.message);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ============================================
// ADDED: MongoDB Selected Part Save/Replace Logic
// When a part is selected, save FULL object to MongoDB
// Replaces previously stored part (delete old, insert new)
// ============================================

/**
 * POST /api/selected-part - Save selected part to MongoDB (replace behavior)
 * Request body:
 *   - projectId: The project ID to associate the part with
 *   - templateType: Template type (LV, MV, HV)
 *   - slotIndex: Slot index within the template
 *   - part: The FULL part object from EPLAN SQL
 *
 * Behavior: Deletes previous part in this slot, inserts the new one
 */
app.post('/api/selected-part', async (req, res) => {
  console.log('📥 POST /api/selected-part - Request received');

  try {
    const { projectId, templateType, slotIndex, part } = req.body;

    // Validate required fields
    if (!projectId || !templateType || slotIndex === undefined || !part) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: projectId, templateType, slotIndex, part'
      });
    }

    // Validate part has partnr (code)
    if (!part.partnr) {
      return res.status(400).json({
        success: false,
        error: 'Part object must contain partnr field'
      });
    }

    console.log(`📝 Saving part ${part.partnr} to project ${projectId}, template ${templateType}, slot ${slotIndex}`);

    // Store part with full specifications in MongoDB selected_parts collection
    // This implements the replacement behavior: delete old, insert new
    const selectedPartsCollection = db.collection('selected_parts');

    // Step 1: Delete the previously stored part in this slot (if exists)
    await selectedPartsCollection.deleteOne({
      projectId: projectId,
      templateType: templateType,
      slotIndex: slotIndex
    });
    console.log('🗑️ Deleted previous part in this slot (if any)');

    // Step 2: Insert the newly selected part with FULL specifications
    const partDocument = {
      projectId: projectId,
      templateType: templateType,
      slotIndex: slotIndex,
      part: part, // FULL object with all specifications
      selectedAt: new Date().toISOString()
    };

    await selectedPartsCollection.insertOne(partDocument);
    console.log('✅ New part inserted successfully');

    res.json({
      success: true,
      message: 'Part saved successfully (replaced previous if existed)',
      data: partDocument
    });

  } catch (err) {
    console.error("❌ Error in /api/selected-part:", err.message);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/selected-parts/:projectId - Get all selected parts for a project
 */
app.get('/api/selected-parts/:projectId', async (req, res) => {
  console.log('📥 GET /api/selected-parts/:projectId - Request received');

  try {
    const { projectId } = req.params;

    const selectedParts = await db.collection('selected_parts')
      .find({ projectId: projectId })
      .toArray();

    res.json({
      success: true,
      count: selectedParts.length,
      data: selectedParts
    });

  } catch (err) {
    console.error("❌ Error in /api/selected-parts:", err.message);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * DELETE /api/selected-part - Delete a selected part from MongoDB
 * Request body:
 *   - projectId: The project ID
 *   - templateType: Template type (LV, MV, HV)
 *   - slotIndex: Slot index within the template
 */
app.delete('/api/selected-part', async (req, res) => {
  console.log('📥 DELETE /api/selected-part - Request received');

  try {
    const { projectId, templateType, slotIndex } = req.body;

    if (!projectId || !templateType || slotIndex === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: projectId, templateType, slotIndex'
      });
    }

    const result = await db.collection('selected_parts').deleteOne({
      projectId: projectId,
      templateType: templateType,
      slotIndex: slotIndex
    });

    res.json({
      success: true,
      deleted: result.deletedCount > 0,
      message: result.deletedCount > 0 ? 'Part deleted successfully' : 'No part found in this slot'
    });

  } catch (err) {
    console.error("❌ Error in DELETE /api/selected-part:", err.message);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ============================================
// AI Chatbot Endpoints (local model + online passthrough)
// ============================================
// Multer in memory so we can inspect uploaded files without persisting them.
// 25 MB per file × 10 files cap — adjust as needed.
const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
});

// LOCAL endpoint — forwards prompts to the local model cluster (the VLM on
// 192.168.1.61 by default, OpenAI-compatible HTTP). Returns
// `{reply, tool_calls}` ready for the frontend tool runner, plus `_model`
// and `_host` so the chat panel can show what actually answered.
app.post('/api/chat-local', chatUpload.array('files', 10), async (req, res) => {
  try {
    const prompt = (req.body?.prompt || '').toString();
    const files = (req.files || []).map(f => ({
      name: f.originalname, mimetype: f.mimetype, size: f.size,
    }));

    // Parse multipart strings that the frontend sent as JSON blobs.
    const parseJSON = (s, fallback) => {
      try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
    };
    const context        = parseJSON(req.body?.context,        null);
    const toolSchemas    = parseJSON(req.body?.tools,          []);
    const excelPreviews  = parseJSON(req.body?.excelPreviews,  []);
    const history        = parseJSON(req.body?.history,        []);

    // Extract text from any attached PDFs so the model can read them. This
    // is the magic that powers the "upload a project PDF and have the AI
    // fill in fields" flow — we hand the raw text to the LLM and instruct
    // it (via the system prompt) to wrap its proposals in propose_changes.
    const pdfExtracts = [];
    for (const f of (req.files || [])) {
      if (f.mimetype === 'application/pdf' ||
          (f.originalname || '').toLowerCase().endsWith('.pdf')) {
        const parsed = await extractPdfText(f.buffer, f.originalname);
        if (parsed) pdfExtracts.push({ name: f.originalname, ...parsed });
      }
    }

    const system = buildSystemPrompt(toolSchemas, context, excelPreviews);
    const fileNote = files.length
      ? `\n[Attached files: ${files.map(f => f.name).join(', ')}]`
      : '';
    const pdfNote = pdfExtracts.length
      ? '\n\n── Extracted text from attached PDF(s) ──\n' +
        pdfExtracts.map(p =>
          `📄 ${p.name} (${p.pageCount ?? '?'} pages` +
          `${p.truncated ? `, truncated from ${p.fullLength} chars` : ''}):\n` +
          `<<<\n${p.text}\n>>>`
        ).join('\n\n')
      : '';
    const userMsg = `${prompt}${fileNote}${pdfNote}`;

    let content = '';
    let usedTransport = 'stub';
    let usedModel = DEFAULT_LOCAL_MODEL_NAME;
    let usedUrl = DEFAULT_LOCAL_MODEL_URL;
    let modelError = '';

    try {
      const out = await callLocalModel({ system, user: userMsg, history });
      content = out.content || '';
      usedTransport = out.transport;
      usedModel = out.model || usedModel;
      usedUrl = out.url || usedUrl;
    } catch (e) {
      modelError = e?.message || String(e);
      console.error('Local model call failed:', modelError);
    }

    // If the model is unreachable, return a graceful stub so the frontend
    // still sees the project context made it through.
    if (!content) {
      const target = process.env.LLM_GATEWAY_URL
        ? `llm-gateway @ ${process.env.LLM_GATEWAY_URL}`
        : DEFAULT_LOCAL_MODEL_URL;
      const stub = {
        reply:
          (modelError
            ? `🛈 Could not reach the local model (${target}):\n   ${modelError}\n\n`
            : `🛈 No reply from the local model (${target}).\n\n`) +
          `Routing: ${DEFAULT_LOCAL_MODEL_NAME} at ${DEFAULT_LOCAL_MODEL_URL}.\n` +
          `Change it with LOCAL_MODEL_URL / LOCAL_MODEL_NAME in .env (compose passes them through), ` +
          `or route via LLM_GATEWAY_URL — see simorgh-backend/.env.example.\n` +
          `Note: the model host IP-allowlists 192.168.1.68 + localhost; a call from anywhere else is refused by its nginx.\n\n` +
          `Echo: ${prompt || '(empty)'}` + fileNote,
        tool_calls: [],
        _model: DEFAULT_LOCAL_MODEL_NAME,
        _host: DEFAULT_LOCAL_MODEL_URL,
        _transport: 'stub',
      };
      return res.json(stub);
    }

    const envelope = extractToolEnvelope(content);
    // Tag the reply with the transport used so it's debuggable from the UI,
    // and echo back the extracted PDF text so the frontend can keep it on
    // the user message for future turns.
    return res.json({
      reply: envelope.reply,
      tool_calls: envelope.tool_calls,
      _transport: usedTransport,
      _model: usedModel,
      _host: usedUrl,
      _extractedDocs: pdfExtracts.map(p => ({ name: p.name, text: p.text })),
    });
  } catch (err) {
    console.error('Chat local error:', err);
    res.status(500).json({ reply: '', tool_calls: [], error: err.message });
  }
});

// ONLINE endpoint — calls an OpenAI-compatible chat completions URL (any
// provider that speaks the OpenAI schema works: OpenAI, Anthropic gateways,
// Together, Groq, OpenRouter, etc.). Uses the same JSON tool-call protocol
// as the local endpoint so the frontend code path is identical.
app.post('/api/chat-online', chatUpload.array('files', 10), async (req, res) => {
  try {
    const prompt = (req.body?.prompt || '').toString();
    const files = (req.files || []).map(f => ({
      name: f.originalname, mimetype: f.mimetype, size: f.size,
    }));

    const parseJSON = (s, fallback) => {
      try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
    };
    const context       = parseJSON(req.body?.context,       null);
    const toolSchemas   = parseJSON(req.body?.tools,         []);
    const excelPreviews = parseJSON(req.body?.excelPreviews, []);

    const upstream = process.env.ONLINE_MODEL_URL;
    if (!upstream) {
      return res.json({
        reply: '🌐 ONLINE endpoint is not configured. Set ONLINE_MODEL_URL (OpenAI-compatible) and ONLINE_MODEL_KEY in the backend .env.',
        tool_calls: [],
      });
    }

    const system  = buildSystemPrompt(toolSchemas, context, excelPreviews);
    const userMsg = `${prompt}${files.length ? `\n[Attached files: ${files.map(f => f.name).join(', ')}]` : ''}`;

    const body = {
      model: process.env.ONLINE_MODEL_NAME || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: userMsg },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    };

    const upRes = await fetch(upstream, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.ONLINE_MODEL_KEY ? { Authorization: `Bearer ${process.env.ONLINE_MODEL_KEY}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await upRes.text();
    if (!upRes.ok) {
      return res.status(upRes.status).json({
        reply: `❌ Online model error ${upRes.status}: ${text.slice(0, 500)}`,
        tool_calls: [],
      });
    }
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    const content =
      json?.choices?.[0]?.message?.content ??
      json?.message?.content ??
      json?.response ??
      json?.raw ??
      '';
    const envelope = extractToolEnvelope(content || '');
    return res.json({ reply: envelope.reply, tool_calls: envelope.tool_calls, _transport: 'openai-online' });
  } catch (err) {
    console.error('Chat online error:', err);
    res.status(500).json({ reply: '', tool_calls: [], error: err.message });
  }
});

// ============================================
// Revision Management APIs
// ============================================

/**
 * GET /api/projects/:projectId/revisions - Get all revisions for a project
 */
app.get('/api/projects/:projectId/revisions', async (req, res) => {
  try {
    const { projectId } = req.params;
    
    // Get all revisions for the project sorted by revisionNumber descending (latest first)
    const revisions = await db.collection('revisions')
      .find({ projectId })
      .sort({ revisionNumber: -1 })
      .toArray();
    
    // Auto-create Revision 0 if no revisions exist for this project
    if (revisions.length === 0) {
      console.log(`No revisions found for project ${projectId}, creating Revision 0...`);
      
      const revision0Data = {
        projectId,
        revisionNumber: '0',
        revisionName: 'Initial',
        description: 'Base revision created automatically',
        createdBy: 'system',
        projectSnapshot: null,
        isLocked: false,
        createdOn: new Date().toISOString(),
        changedOn: new Date().toISOString()
      };
      
      const result = await db.collection('revisions').insertOne(revision0Data);
      const revision0 = { _id: result.insertedId, ...revision0Data };
      
      return res.json([revision0]);
    }
    
    res.json(revisions);
  } catch (error) {
    console.error('Error fetching revisions:', error);
    res.status(500).json({ error: 'Failed to fetch revisions' });
  }
});

/**
 * GET /api/revisions/:revisionId - Get a specific revision
 */
app.get('/api/revisions/:revisionId', async (req, res) => {
  try {
    const { revisionId } = req.params;
    const revision = await db.collection('revisions').findOne({ _id: new ObjectId(revisionId) });
    if (!revision) {
      return res.status(404).json({ error: 'Revision not found' });
    }
    res.json(revision);
  } catch (error) {
    console.error('Error fetching revision:', error);
    res.status(500).json({ error: 'Failed to fetch revision' });
  }
});

/**
 * POST /api/revisions - Create a new revision
 */
app.post('/api/revisions', async (req, res) => {
  try {
    const revisionData = { 
      ...req.body, 
      createdOn: new Date().toISOString(), 
      changedOn: new Date().toISOString() 
    };
    
    // Validate required fields
    if (!revisionData.projectId || !revisionData.revisionNumber) {
      return res.status(400).json({ error: 'projectId and revisionNumber are required' });
    }
    
    // Check if revision number already exists for this project (unique constraint)
    const existing = await db.collection('revisions').findOne({
      projectId: revisionData.projectId,
      revisionNumber: revisionData.revisionNumber
    });
    
    if (existing) {
      return res.status(409).json({ error: `Revision ${revisionData.revisionNumber} already exists for this project` });
    }
    
    // Insert the revision
    const result = await db.collection('revisions').insertOne(revisionData);
    
    // Return the created revision with its ID
    res.status(201).json({ _id: result.insertedId, ...revisionData });
  } catch (error) {
    console.error('Error creating revision:', error);
    res.status(500).json({ error: 'Failed to create revision' });
  }
});

/**
 * PUT /api/revisions/:revisionId - Update a revision
 */
app.put('/api/revisions/:revisionId', async (req, res) => {
  try {
    const { revisionId } = req.params;
    const result = await db.collection('revisions').findOneAndUpdate(
      { _id: new ObjectId(revisionId) },
      { $set: { ...req.body, changedOn: new Date().toISOString() } },
      { returnDocument: 'after' }
    );
    if (!result) {
      return res.status(404).json({ error: 'Revision not found' });
    }
    res.json(result);
  } catch (error) {
    console.error('Error updating revision:', error);
    res.status(500).json({ error: 'Failed to update revision' });
  }
});

/**
 * DELETE /api/revisions/:revisionId - Delete a revision
 */
app.delete('/api/revisions/:revisionId', async (req, res) => {
  try {
    const { revisionId } = req.params;
    const revision = await db.collection('revisions').findOne({ _id: new ObjectId(revisionId) });
    
    if (!revision) {
      return res.status(404).json({ error: 'Revision not found' });
    }
    
    // Cannot delete locked revision
    if (revision.isLocked) {
      return res.status(400).json({ error: 'Cannot delete a locked revision' });
    }
    
    const result = await db.collection('revisions').deleteOne({ _id: new ObjectId(revisionId) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Revision not found' });
    }
    res.json({ message: 'Revision deleted successfully' });
  } catch (error) {
    console.error('Error deleting revision:', error);
    res.status(500).json({ error: 'Failed to delete revision' });
  }
});

/**
 * GET /api/revisions/compare - Compare two revisions
 */
app.get('/api/revisions/compare', async (req, res) => {
  try {
    const { base, target } = req.query;
    
    if (!base || !target) {
      return res.status(400).json({ error: 'Both base and target revision IDs are required' });
    }
    
    const baseRevision = await db.collection('revisions').findOne({ _id: new ObjectId(base) });
    const targetRevision = await db.collection('revisions').findOne({ _id: new ObjectId(target) });
    
    if (!baseRevision || !targetRevision) {
      return res.status(404).json({ error: 'One or both revisions not found' });
    }
    
    // Simple comparison logic - compare project snapshots
    const differences = {
      added: [],
      removed: [],
      modified: []
    };
    
    const baseSnapshot = baseRevision.projectSnapshot;
    const targetSnapshot = targetRevision.projectSnapshot;
    
    // Compare equipments
    const baseEqIds = new Set((baseSnapshot.equipments || []).map(e => e.id));
    const targetEqIds = new Set((targetSnapshot.equipments || []).map(e => e.id));
    
    targetEqIds.forEach(id => {
      if (!baseEqIds.has(id)) {
        differences.added.push(`Equipment: ${id}`);
      }
    });
    
    baseEqIds.forEach(id => {
      if (!targetEqIds.has(id)) {
        differences.removed.push(`Equipment: ${id}`);
      }
    });
    
    // Compare templates
    ['LV', 'MV', 'HV'].forEach(tier => {
      const baseTemplates = baseSnapshot.templates?.[tier] || [];
      const targetTemplates = targetSnapshot.templates?.[tier] || [];
      
      baseTemplates.forEach(bt => {
        const targetT = targetTemplates.find(tt => tt.id === bt.id);
        if (!targetT) {
          differences.removed.push(`Template (${tier}): ${bt.name}`);
        } else if (JSON.stringify(bt.properties) !== JSON.stringify(targetT.properties)) {
          differences.modified.push({
            field: `Template (${tier}): ${bt.name}`,
            oldValue: bt.properties,
            newValue: targetT.properties
          });
        }
      });
    });
    
    res.json({
      baseRevision,
      targetRevision,
      differences
    });
  } catch (error) {
    console.error('Error comparing revisions:', error);
    res.status(500).json({ error: 'Failed to compare revisions' });
  }
});

/**
 * GET /api/revisions/compare/export - Export comparison report (PDF or Excel)
 */
app.get('/api/revisions/compare/export', async (req, res) => {
  try {
    const { base, target, format } = req.query;
    
    if (!base || !target || !format) {
      return res.status(400).json({ error: 'base, target, and format parameters are required' });
    }
    
    // Fetch revisions
    const baseRevision = await db.collection('revisions').findOne({ _id: new ObjectId(base) });
    const targetRevision = await db.collection('revisions').findOne({ _id: new ObjectId(target) });
    
    if (!baseRevision || !targetRevision) {
      return res.status(404).json({ error: 'One or both revisions not found' });
    }
    
    // Build comparison data
    const differences = {
      added: [],
      removed: [],
      modified: []
    };
    
    const baseSnapshot = baseRevision.projectSnapshot;
    const targetSnapshot = targetRevision.projectSnapshot;
    
    // Compare equipments
    const baseEqIds = new Set((baseSnapshot.equipments || []).map(e => e.id));
    const targetEqIds = new Set((targetSnapshot.equipments || []).map(e => e.id));
    
    targetEqIds.forEach(id => {
      if (!baseEqIds.has(id)) {
        differences.added.push(`Equipment: ${id}`);
      }
    });
    
    baseEqIds.forEach(id => {
      if (!targetEqIds.has(id)) {
        differences.removed.push(`Equipment: ${id}`);
      }
    });
    
    // Compare templates
    ['LV', 'MV', 'HV'].forEach(tier => {
      const baseTemplates = baseSnapshot.templates?.[tier] || [];
      const targetTemplates = targetSnapshot.templates?.[tier] || [];
      
      baseTemplates.forEach(bt => {
        const targetT = targetTemplates.find(tt => tt.id === bt.id);
        if (!targetT) {
          differences.removed.push(`Template (${tier}): ${bt.name}`);
        } else if (JSON.stringify(bt.properties) !== JSON.stringify(targetT.properties)) {
          differences.modified.push({
            field: `Template (${tier}): ${bt.name}`,
            oldValue: bt.properties,
            newValue: targetT.properties
          });
        }
      });
    });
    
    if (format === 'pdf') {
      // Generate PDF report
      const doc = new PDFDocument({ margin: 50 });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="revision_comparison_${baseRevision.revisionNumber}_vs_${targetRevision.revisionNumber}.pdf"`);
      doc.pipe(res);
      
      // Title
      doc.fontSize(20).text('Revision Comparison Report', { align: 'center' });
      doc.moveDown();
      doc.fontSize(12).text(`Project: ${baseSnapshot.projectName}`, { align: 'center' });
      doc.text(`Base Revision: ${baseRevision.revisionNumber} - ${baseRevision.revisionName}`, { align: 'center' });
      doc.text(`Target Revision: ${targetRevision.revisionNumber} - ${targetRevision.revisionName}`, { align: 'center' });
      doc.text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
      doc.moveDown(2);
      
      // Summary
      doc.fontSize(14).text('Summary', { underline: true });
      doc.moveDown();
      doc.fontSize(11).text(`Added Items: ${differences.added.length}`);
      doc.text(`Removed Items: ${differences.removed.length}`);
      doc.text(`Modified Items: ${differences.modified.length}`);
      doc.moveDown(2);
      
      // Added section
      if (differences.added.length > 0) {
        doc.fontSize(14).text('Added Items', { underline: true });
        doc.moveDown();
        differences.added.forEach(item => {
          doc.fontSize(10).text(`• ${item}`, { bullet: true });
        });
        doc.moveDown(2);
      }
      
      // Removed section
      if (differences.removed.length > 0) {
        doc.fontSize(14).text('Removed Items', { underline: true });
        doc.moveDown();
        differences.removed.forEach(item => {
          doc.fontSize(10).text(`• ${item}`, { bullet: true });
        });
        doc.moveDown(2);
      }
      
      // Modified section
      if (differences.modified.length > 0) {
        doc.fontSize(14).text('Modified Items', { underline: true });
        doc.moveDown();
        differences.modified.forEach((mod, idx) => {
          doc.fontSize(10).text(`${idx + 1}. ${mod.field}`, { bold: true });
          doc.text(`   Old: ${JSON.stringify(mod.oldValue)}`, { continued: false });
          doc.text(`   New: ${JSON.stringify(mod.newValue)}`);
          doc.moveDown(0.5);
        });
      }
      
      doc.end();
    } else if (format === 'excel') {
      // Generate Excel report
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Comparison Report');
      
      // Title row
      worksheet.addRow(['Revision Comparison Report']);
      worksheet.addRow(['Project:', baseSnapshot.projectName]);
      worksheet.addRow(['Base Revision:', `${baseRevision.revisionNumber} - ${baseRevision.revisionName}`]);
      worksheet.addRow(['Target Revision:', `${targetRevision.revisionNumber} - ${targetRevision.revisionName}`]);
      worksheet.addRow(['Generated:', new Date().toLocaleString()]);
      worksheet.addRow([]);
      
      // Summary
      worksheet.addRow(['Summary']);
      worksheet.addRow(['Added Items', differences.added.length]);
      worksheet.addRow(['Removed Items', differences.removed.length]);
      worksheet.addRow(['Modified Items', differences.modified.length]);
      worksheet.addRow([]);
      
      // Added items
      worksheet.addRow(['Added Items']);
      differences.added.forEach(item => {
        worksheet.addRow([item]);
      });
      worksheet.addRow([]);
      
      // Removed items
      worksheet.addRow(['Removed Items']);
      differences.removed.forEach(item => {
        worksheet.addRow([item]);
      });
      worksheet.addRow([]);
      
      // Modified items
      worksheet.addRow(['Modified Items']);
      worksheet.addRow(['Field', 'Old Value', 'New Value']);
      differences.modified.forEach(mod => {
        worksheet.addRow([mod.field, JSON.stringify(mod.oldValue), JSON.stringify(mod.newValue)]);
      });
      
      // Set headers
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="revision_comparison_${baseRevision.revisionNumber}_vs_${targetRevision.revisionNumber}.xlsx"`);
      
      await workbook.xlsx.write(res);
      res.end();
    } else {
      return res.status(400).json({ error: 'Invalid format. Use "pdf" or "excel"' });
    }
  } catch (error) {
    console.error('Error exporting comparison:', error);
    res.status(500).json({ error: 'Failed to export comparison' });
  }
});

// ============================================
// Process-level safety net
// ============================================
// Any unhandled error anywhere else in the app (not just the DB pools above,
// which now handle their own) would otherwise crash the whole process and
// take down every in-flight request/connection, not just the one that
// failed. Log and keep serving instead.
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled rejection:', reason);
});

// ============================================
// Server Startup
// ============================================
async function startServer() {
  await connectToDatabase();

  // Try to connect to SQL Server on startup (non-blocking)
  connectToSqlServer().catch(err => {
    console.warn("⚠️ Initial SQL Server connection failed, will retry on first request");
  });

  // Try to connect to MySQL on startup (non-blocking)
  connectToMySql().catch(err => {
    console.warn("⚠️ Initial MySQL connection failed, will retry on first request");
  });

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Health: http://localhost:${PORT}/api/health`);
    console.log(`\n📊 EPLAN API (SQL Server):`);
    console.log(`   Parts: http://localhost:${PORT}/api/parts`);
    console.log(`   Manufacturers: http://localhost:${PORT}/api/manufacturers`);
    console.log(`\n📋 TPMS API (MySQL):`);
    console.log(`   Projects: http://localhost:${PORT}/api/tpms/projects`);
    console.log(`   Scopes: http://localhost:${PORT}/api/tpms/scopes/:projectId`);
    console.log(`   Revisions: http://localhost:${PORT}/api/tpms/revisions/:scopeId`);
    console.log(`\n🔄 Revision Management:`);
    console.log(`   Revisions: http://localhost:${PORT}/api/projects/:projectId/revisions`);
    console.log(`   Compare: http://localhost:${PORT}/api/revisions/compare?base=&target=`);
  });
}

startServer();
