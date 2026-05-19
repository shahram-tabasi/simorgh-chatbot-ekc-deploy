// server.js - نسخه نهایی با فیلتر سازنده و اتصال SQL + MySQL
import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import cors from 'cors';
import dotenv from 'dotenv';
import sql from 'mssql';
import mysql from 'mysql2/promise';
import multer from 'multer';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = process.env.DATABASE_NAME || 'simorgh_db';

app.use(cors());
app.use(express.json());

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
  queueLimit: 0
};

let mysqlPool;

// Connect to MySQL (READ-ONLY)
async function connectToMySql() {
  try {
    if (!mysqlPool) {
      console.log("🔄 Connecting to MySQL (TPMS)...");
      mysqlPool = mysql.createPool(mysqlConfig);
      // Test connection
      const connection = await mysqlPool.getConnection();
      connection.release();
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

    // Check MySQL connection status
    let mysqlStatus = 'disconnected';
    if (mysqlPool) {
      try {
        const conn = await mysqlPool.getConnection();
        conn.release();
        mysqlStatus = 'connected';
      } catch (err) {
        mysqlStatus = 'error';
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
// TPMS MySQL API - Project List (READ-ONLY)
// Based on C# ViewProjectMains query
// ============================================

/**
 * GET /api/tpms/projects - Get project list from TPMS MySQL database
 * Returns: [{ value: IdprojectMain, text: Oenum + ProjectName }]
 * Equivalent to C#: _tpmsContext.ViewProjectMains.Select(p => new SelectListItem { Value = p.IdprojectMain.ToString(), Text = p.Oenum + p.ProjectName })
 */
app.get('/api/tpms/projects', async (req, res) => {
  console.log('📥 GET /api/tpms/projects - Request received');

  try {
    const pool = await connectToMySql();

    // Query ViewProjectMains table (READ-ONLY)
    // Matches C# query: Select(p => new SelectListItem { Value = p.IdprojectMain.ToString(), Text = p.Oenum + p.ProjectName })
    const [rows] = await pool.execute(`
      SELECT
        IdprojectMain as value,
        CONCAT(COALESCE(Oenum, ''), COALESCE(ProjectName, '')) as text
      FROM ViewProjectMains
      ORDER BY ProjectName
    `);

    console.log(`✅ Loaded ${rows.length} projects from TPMS`);

    res.json({
      success: true,
      count: rows.length,
      projects: rows
    });

  } catch (err) {
    console.error("❌ Error in /api/tpms/projects:", err.message);
    res.status(500).json({
      success: false,
      error: err.message,
      projects: []
    });
  }
});

/**
 * GET /api/tpms/scopes/:projectId - Get scopes for a project
 * For future implementation when needed
 */
app.get('/api/tpms/scopes/:projectId', async (req, res) => {
  console.log('📥 GET /api/tpms/scopes - Request received');

  try {
    const pool = await connectToMySql();
    const { projectId } = req.params;

    // Query for scopes based on project (READ-ONLY)
    // Adjust table/column names based on your actual schema
    const [rows] = await pool.execute(`
      SELECT
        IdScope as value,
        ScopeName as text
      FROM ViewScopes
      WHERE IdprojectMain = ?
      ORDER BY ScopeName
    `, [projectId]);

    console.log(`✅ Loaded ${rows.length} scopes for project ${projectId}`);

    res.json({
      success: true,
      count: rows.length,
      scopes: rows
    });

  } catch (err) {
    console.error("❌ Error in /api/tpms/scopes:", err.message);
    res.status(500).json({
      success: false,
      error: err.message,
      scopes: []
    });
  }
});

/**
 * GET /api/tpms/revisions/:scopeId - Get revisions for a scope
 * For future implementation when needed
 */
app.get('/api/tpms/revisions/:scopeId', async (req, res) => {
  console.log('📥 GET /api/tpms/revisions - Request received');

  try {
    const pool = await connectToMySql();
    const { scopeId } = req.params;

    // Query for revisions based on scope (READ-ONLY)
    // Adjust table/column names based on your actual schema
    const [rows] = await pool.execute(`
      SELECT
        IdRevision as value,
        RevName as text
      FROM ViewRevisions
      WHERE IdScope = ?
      ORDER BY RevName
    `, [scopeId]);

    console.log(`✅ Loaded ${rows.length} revisions for scope ${scopeId}`);

    res.json({
      success: true,
      count: rows.length,
      revisions: rows
    });

  } catch (err) {
    console.error("❌ Error in /api/tpms/revisions:", err.message);
    res.status(500).json({
      success: false,
      error: err.message,
      revisions: []
    });
  }
});

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

// ── Tool-call protocol helpers ──────────────────────────────────────────────
// The frontend sends the user's prompt together with:
//   • `context`  — JSON snapshot of the active project (equipments, selected one, template counts)
//   • `tools`    — JSON schemas of the frontend tools the assistant is allowed to call
//   • `excelPreviews` — parsed rows from any attached Excel/CSV file
// The model must reply in this exact shape so the frontend can execute the calls:
//   {
//     "reply": "human-readable explanation in Persian if the user wrote Persian",
//     "tool_calls": [ { "name": "update_row", "args": {...} }, ... ]
//   }
// When the answer is purely conversational, `tool_calls` is `[]`.
function buildSystemPrompt(toolSchemas, context, excelPreviews) {
  const toolsBlock = (Array.isArray(toolSchemas) && toolSchemas.length > 0)
    ? toolSchemas.map(t => {
        const args = Object.entries(t.args || {})
          .map(([k, v]) => `      "${k}": ${v.type}${v.required ? ' (required)' : ''} — ${v.description}`)
          .join('\n');
        return `  - ${t.name}: ${t.description}\n    args:\n${args}`;
      }).join('\n\n')
    : '  (no tools available)';

  const ctxText = context
    ? JSON.stringify(context, null, 2)
    : '(no project context)';

  const excelText = (Array.isArray(excelPreviews) && excelPreviews.length > 0)
    ? excelPreviews.map(p => {
        const headers = p.rows[0] ? Object.keys(p.rows[0]) : [];
        return `[Excel: ${p.name}] columns=${JSON.stringify(headers)}, rowCount=${p.rows.length}`;
      }).join('\n')
    : '(no spreadsheet attachments)';

  return [
    'You are Simorgh AI, an electrical-design assistant embedded inside the Simorgh Soft application.',
    'You both ANSWER questions and ACT on the running project by calling tools.',
    'The user may write in Persian, English, or a mix; reply in the same language as the user.',
    '',
    'You MUST respond with a single JSON object — no prose outside it — of the form:',
    '  {"reply": "<your answer>", "tool_calls": [ {"name": "<tool>", "args": { ... }}, ... ]}',
    'If no action is needed, return an empty tool_calls array.',
    '',
    'Rules:',
    '  • Use only the tools listed below; do not invent tool names.',
    '  • For row-level edits, prefer `bulk_update` over many `update_row` calls.',
    '  • When the user attached an Excel file, you may call `apply_excel` with the parsed rows.',
    '    The frontend already parsed each Excel attachment into JSON; you must use the EXACT column header names from the file as keys in `columnMapping`.',
    '  • Reference columns by their internal field name (wiringType, ratingPower, flc, feederNo, busSection, tag, description, cableSize, sfdHfd, moduleNo, size, templateName).',
    '  • Validate that the targeted equipment exists in the context before issuing an edit; if you are unsure, ask in `reply` and return tool_calls=[].',
    '  • Never wrap the JSON in code fences. Return raw JSON only.',
    '',
    '── Project context ──',
    ctxText,
    '',
    '── Spreadsheet attachments ──',
    excelText,
    '',
    '── Available tools ──',
    toolsBlock,
  ].join('\n');
}

// Pull a JSON envelope out of the model's reply. The model is instructed to
// emit raw JSON; in practice it sometimes wraps it in prose or fences.
function extractToolEnvelope(content) {
  if (typeof content !== 'string') content = String(content ?? '');
  const tryParse = (s) => {
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === 'object') {
        return {
          reply: typeof obj.reply === 'string' ? obj.reply : '',
          tool_calls: Array.isArray(obj.tool_calls) ? obj.tool_calls : [],
        };
      }
    } catch { /* not JSON */ }
    return null;
  };

  // 1) Whole content as JSON
  const whole = tryParse(content.trim());
  if (whole) return whole;

  // 2) Fenced ```json … ```
  const fence = content.match(/```(?:json)?\s*([\s\S]+?)```/i);
  if (fence) {
    const parsed = tryParse(fence[1].trim());
    if (parsed) return parsed;
  }

  // 3) First balanced `{...}` block via brace counting
  const start = content.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') {
        depth--;
        if (depth === 0) {
          const parsed = tryParse(content.slice(start, i + 1));
          if (parsed) return parsed;
          break;
        }
      }
    }
  }

  // 4) Pure text reply, no tools
  return { reply: content, tool_calls: [] };
}

// Detect which transport to use for the local model.
//   - Explicit `LOCAL_MODEL_URL` → POST as-is. If the URL contains `/v1/chat/completions`
//     it's treated as OpenAI-compatible; if it ends with `/api/chat` it's Ollama.
//   - Otherwise fall back to default Ollama at http://127.0.0.1:11434/api/chat.
async function callLocalModel({ system, user, model, abortMs }) {
  const explicit = process.env.LOCAL_MODEL_URL;
  const ollamaHost = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const apiKey = process.env.LOCAL_MODEL_KEY || '';

  const url = explicit || `${ollamaHost}/api/chat`;
  const isOpenAI = /\/v1\/chat\/completions/i.test(url);
  const isOllama = !isOpenAI; // default

  const messages = [
    { role: 'system', content: system },
    { role: 'user',   content: user },
  ];

  const headers = {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };

  const body = isOllama
    ? { model: model || process.env.LOCAL_MODEL_NAME || 'llama3.1', messages, stream: false, format: 'json', options: { temperature: 0.1 } }
    : { model: model || process.env.LOCAL_MODEL_NAME || 'local',    messages, temperature: 0.1, response_format: { type: 'json_object' } };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), abortMs || 90_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Local model ${res.status}: ${text.slice(0, 500)}`);
    }
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    // Normalise different response shapes into a single `content` string.
    const content =
      json?.message?.content ??
      json?.choices?.[0]?.message?.content ??
      json?.response ??
      json?.raw ??
      '';
    return { content, raw: json, url, transport: isOllama ? 'ollama' : 'openai-compatible' };
  } finally {
    clearTimeout(timer);
  }
}

// LOCAL endpoint — forwards prompts to a local model (Ollama by default,
// or any OpenAI-compatible `/v1/chat/completions` server via LOCAL_MODEL_URL).
// Returns `{reply, tool_calls}` ready for the frontend tool runner.
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

    const system = buildSystemPrompt(toolSchemas, context, excelPreviews);
    const fileNote = files.length
      ? `\n[Attached files: ${files.map(f => f.name).join(', ')}]`
      : '';
    const userMsg = `${prompt}${fileNote}`;

    let content = '';
    let usedTransport = 'stub';
    let modelError = '';

    try {
      const out = await callLocalModel({ system, user: userMsg });
      content = out.content || '';
      usedTransport = out.transport;
    } catch (e) {
      modelError = e?.message || String(e);
      console.error('Local model call failed:', modelError);
    }

    // If the model is unreachable, return a graceful stub so the frontend
    // still sees the project context made it through.
    if (!content) {
      const stub = {
        reply:
          (modelError
            ? `🛈 Could not reach local model: ${modelError}\n`
            : '🛈 Local model not configured.\n') +
          `Set LOCAL_MODEL_URL (OpenAI-compatible) or run Ollama on ${process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'} and set LOCAL_MODEL_NAME.\n\n` +
          `Echo: ${prompt || '(empty)'}` + fileNote,
        tool_calls: [],
      };
      return res.json(stub);
    }

    const envelope = extractToolEnvelope(content);
    // Tag the reply with the transport used so it's debuggable from the UI.
    return res.json({
      reply: envelope.reply,
      tool_calls: envelope.tool_calls,
      _transport: usedTransport,
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
  });
}

startServer();
