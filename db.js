
const sql = require('mssql/msnodesqlv8');

require('dotenv').config();

const config = {
  server: process.env.DB_SERVER || '(localdb)\\MSSQLLocalDB',
  database: process.env.DB_DATABASE || 'WebGIS_DB',

  options: {
    trustedConnection: true,
    trustServerCertificate: true,
  },

  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

const poolPromise = new sql.ConnectionPool(config)
  .connect()
  .then(pool => {
    console.log('Successfully connected to SQL Server!');
    return pool;
  })
  .catch(error => {
    console.error('Database connection error:', error);
    throw error;
  });

module.exports = { sql, poolPromise };
