
const express = require('express');
const cors = require('cors');
const { poolPromise } = require('./db');
const { initializeActiveCatalog } = require('./models/activeCatalog');

const teaFarmerRoutes = require('./routes/teaFarmerRoutes');

const app = express();

app.use(cors({
    origin: 'http://localhost:5173'
}));

app.use(express.json({ limit: '5mb' }));

// Health API
app.get('/api/health', async (req, res) => {
    try {
        const pool = await poolPromise;

        const result = await pool.request().query(`
            SELECT COUNT(*) AS totalRecords
            FROM dbo.TeaFarmer_Records
        `);

        res.json({
            status: 'success',
            database: 'WebGIS_DB',
            totalRecords: result.recordset[0].totalRecords
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            status: 'error',
            message: 'Database connection failed'
        });
    }
});

// Tea Farmer APIs
app.use('/api/tea-farmers', teaFarmerRoutes);

const PORT = 5000;

async function startServer() {
    try {
        await initializeActiveCatalog();
        app.listen(PORT, () => {
            console.log(`WebGIS API running at http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error('Could not initialize the active database schema:', error);
        process.exitCode = 1;
        try {
            const pool = await poolPromise;
            await pool.close();
        } catch { /* connection setup already failed */ }
    }
}

startServer();
