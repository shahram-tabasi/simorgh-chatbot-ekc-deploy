const express = require('express');
const sql = require('mssql');
const path = require('path');
const fs = require('fs');
const app = express();

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// Static files
app.use(express.static(__dirname));

// Database config
const config = {
    user: 'userfanni',
    password: '12345678',
    server: '192.168.1.39',
    database: 'Eplan_n2',
    port: 1433,
    options: {
        encrypt: false,
        trustServerCertificate: true,
        connectTimeout: 30000,
        requestTimeout: 30000
    },
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    }
};

let pool;

async function connectDB() {
    try {
        if (!pool) {
            console.log("🔄 در حال اتصال به SQL Server...");
            pool = await sql.connect(config);
            console.log("✅ اتصال به دیتابیس برقرار شد!\n");
        }
        return pool;
    } catch (err) {
        console.error("❌ خطای اتصال:", err.message);
        pool = null;
        throw err;
    }
}

// Root route
app.get('/', (req, res) => {
    const htmlPath = path.join(__dirname, 'EPLAN-Viewer.html');
    
    if (fs.existsSync(htmlPath)) {
        res.sendFile(htmlPath);
    } else {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>EPLAN API</title>
                <style>
                    body {
                        font-family: Arial;
                        background: linear-gradient(135deg, #667eea, #764ba2);
                        padding: 50px;
                        text-align: center;
                        color: white;
                    }
                    .card {
                        background: white;
                        color: #333;
                        padding: 40px;
                        border-radius: 20px;
                        max-width: 600px;
                        margin: auto;
                    }
                    a {
                        display: inline-block;
                        background: #667eea;
                        color: white;
                        padding: 10px 20px;
                        border-radius: 8px;
                        text-decoration: none;
                        margin: 10px;
                    }
                </style>
            </head>
            <body>
                <div class="card">
                    <h1>✅ سرور EPLAN در حال اجراست!</h1>
                    <p>Database: Eplan_n2 @ 192.168.1.39</p>
                    <p>User: userfanni</p>
                    <h3>تست API:</h3>
                    <a href="/parts?offset=0" target="_blank">دریافت قطعات</a>
                    <a href="/export" target="_blank">دانلود CSV</a>
                    <a href="/health" target="_blank">وضعیت سرور</a>
                    <hr>
                    <p><small>برای استفاده از رابط کاربری، فایل EPLAN-Viewer.html را در پوشه پروژه قرار دهید</small></p>
                </div>
            </body>
            </html>
        `);
    }
});

// Health check endpoint
app.get('/health', async (req, res) => {
    const status = {
        server: 'running',
        timestamp: new Date().toISOString(),
        database: {
            connected: !!pool,
            config: {
                server: config.server,
                database: config.database,
                user: config.user
            }
        }
    };
    
    if (pool) {
        try {
            const result = await pool.request().query('SELECT 1 AS test');
            status.database.query_test = 'success';
        } catch (err) {
            status.database.query_test = 'failed';
            status.database.error = err.message;
        }
    }
    
    res.json(status);
});

// Get parts - FIXED VERSION
app.get('/parts', async (req, res) => {
    console.log('📥 GET /parts - درخواست دریافت شد');
    
    try {
        const db = await connectDB();
        
        let { search = '', man = '', offset = 0 } = req.query;
        offset = parseInt(offset) || 0;
        const limit = 50;

        console.log('📊 پارامترها:', { search, man, offset, limit });

        // Build WHERE conditions
        let where = [];
        let params = {};

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

        if (man) {
            where.push(`manufacturer = @man`);
            params.man = man;
        }

        const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
        console.log('🔍 WHERE:', whereClause);

        // ✅ FIX 1: Count query with NEW request
        const countRequest = db.request();
        Object.keys(params).forEach(key => {
            countRequest.input(key, sql.NVarChar, params[key]);
        });
        
        const countQuery = `SELECT COUNT(*) AS total FROM tblPart ${whereClause}`;
        const countResult = await countRequest.query(countQuery);
        const total = countResult.recordset[0].total;
        console.log(`📈 تعداد کل: ${total}`);

        // ✅ FIX 2: Data query with NEW request (separate from count request!)
        const dataRequest = db.request();
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
        console.log(`📦 رکوردهای دریافتی: ${dataResult.recordset.length}`);

        // ✅ FIX 3: Manufacturers query with NEW request
        let manufacturers = null;
        if (offset === 0) {
            const manRequest = db.request();
            const manQuery = `
                SELECT DISTINCT manufacturer 
                FROM tblPart 
                WHERE manufacturer IS NOT NULL AND manufacturer != ''
                ORDER BY manufacturer
            `;
            const manResult = await manRequest.query(manQuery);
            manufacturers = manResult.recordset.map(r => r.manufacturer);
            console.log(`🏭 تعداد سازندگان: ${manufacturers.length}`);
        }

        const response = {
            success: true,
            total: total,
            data: dataResult.recordset || [],
            manufacturers: manufacturers
        };
        
        res.json(response);

    } catch (err) {
        console.error("❌ خطا در /parts:", err.message);
        console.error(err.stack);
        res.status(500).json({ 
            success: false, 
            error: err.message,
            hint: 'لاگ های سرور را بررسی کنید'
        });
    }
});

// Export CSV - FIXED VERSION
app.get('/export', async (req, res) => {
    console.log('📥 GET /export - درخواست دریافت شد');
    
    try {
        const db = await connectDB();
        let { search = '', man = '' } = req.query;

        // Build WHERE conditions
        let where = [];
        let params = {};

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

        if (man) {
            where.push(`manufacturer = @man`);
            params.man = man;
        }

        const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

        // Create export request
        const exportRequest = db.request();
        Object.keys(params).forEach(key => {
            exportRequest.input(key, sql.NVarChar, params[key]);
        });

        const query = `
            SELECT 
                partnr, typenr, ordernr, manufacturer,
                description1, description2, description3,
                productgroup, productsubgroup,
                width, height, depth, weight,
                mountinglocation, mountingspace,
                certificate_CE, certificate_UL, certificate_ATEX
            FROM tblPart
            ${whereClause}
            ORDER BY partnr
        `;

        const result = await exportRequest.query(query);
        const data = result.recordset;

        // Generate CSV with UTF-8 BOM
        let csv = '\uFEFF';
        
        const headers = [
            'Part Number', 'Type Number', 'Order Number', 'Manufacturer',
            'Description 1', 'Description 2', 'Description 3',
            'Product Group', 'Product Subgroup',
            'Width', 'Height', 'Depth', 'Weight',
            'Mounting Location', 'Mounting Space',
            'CE', 'UL', 'ATEX'
        ];
        csv += headers.join(',') + '\n';

        data.forEach(row => {
            const line = [
                escapeCSV(row.partnr),
                escapeCSV(row.typenr),
                escapeCSV(row.ordernr),
                escapeCSV(row.manufacturer),
                escapeCSV(row.description1),
                escapeCSV(row.description2),
                escapeCSV(row.description3),
                escapeCSV(row.productgroup),
                escapeCSV(row.productsubgroup),
                row.width || '',
                row.height || '',
                row.depth || '',
                row.weight || '',
                escapeCSV(row.mountinglocation),
                escapeCSV(row.mountingspace),
                row.certificate_CE ? 'Yes' : 'No',
                row.certificate_UL ? 'Yes' : 'No',
                row.certificate_ATEX ? 'Yes' : 'No'
            ];
            csv += line.join(',') + '\n';
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="EPLAN_Parts_${Date.now()}.csv"`);
        res.send(csv);

        console.log(`✅ ${data.length} قطعه Export شد`);

    } catch (err) {
        console.error("❌ خطا در /export:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

function escapeCSV(str) {
    if (!str) return '';
    str = String(str);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

// Start server
const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0';

const server = app.listen(PORT, HOST, () => {
    console.log("\n" + "╔" + "═".repeat(44) + "╗");
    console.log("║   EPLAN Parts Viewer - Server Started    ║");
    console.log("╚" + "═".repeat(44) + "╝");
    console.log(`\n🌐 Local:   http://localhost:${PORT}`);
    console.log(`🌐 Network: http://192.168.1.39:${PORT}`);
    console.log(`\n📊 Database: ${config.server}/${config.database}`);
    console.log(`👤 User:     ${config.user}`);
    console.log(`\n⏳ در حال اتصال به دیتابیس...\n`);
    
    connectDB().catch(err => {
        console.error("\n⚠️  اتصال اولیه به دیتابیس ناموفق بود");
        console.error("    سرور همچنان در حال اجرا است و در درخواست اول مجدد تلاش می‌کند\n");
    });
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ خطا: پورت ${PORT} در حال استفاده است!`);
        console.error(`\n💡 راه حل‌ها:`);
        console.error(`   1. برنامه دیگری که از پورت ${PORT} استفاده می‌کند را ببندید`);
        console.error(`   2. یا پورت را تغییر دهید: PORT=3002 npm start\n`);
    } else {
        console.error('\n❌ خطای سرور:', err.message);
    }
    process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n\n⏹️  در حال خاموش شدن...');
    if (pool) {
        try {
            await pool.close();
            console.log('✅ اتصال دیتابیس بسته شد');
        } catch (err) {
            console.error('خطا در بستن دیتابیس:', err.message);
        }
    }
    server.close(() => {
        console.log('✅ سرور متوقف شد');
        process.exit(0);
    });
});

process.on('SIGTERM', async () => {
    console.log('\n\n⏹️  SIGTERM دریافت شد...');
    if (pool) await pool.close();
    server.close(() => process.exit(0));
});

// Error handlers
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err.message);
    console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', reason);
});
