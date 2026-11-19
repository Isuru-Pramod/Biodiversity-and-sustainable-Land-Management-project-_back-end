const fs = require('node:fs/promises');
const path = require('node:path');
const { sql, poolPromise } = require('../db');

const catalog = require('../data/baselineFieldCatalog.json');
const tableName = 'dbo.TeaFarmer_Records';
const stagingTableName = 'dbo.TeaFarmer_Records_Actual_Load';
const backupTableName = 'dbo.TeaFarmer_Records_TestBackup';
const recordsPath = path.join(__dirname, '..', 'private-data', 'actual-baseline.ndjson');
const mapFields = catalog.mapFields;
const fieldsByKey = new Map(catalog.fields.map(field => [field.key, field]));

function sqlColumn(fieldKey) {
  return quoteIdentifier(fieldsByKey.get(fieldKey).sqlName);
}

function quoteIdentifier(identifier) {
  return '[' + identifier.replaceAll(']', ']]') + ']';
}

function blankToNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.trim() === '' ? null : text;
}

async function readSourceRows() {
  const contents = await fs.readFile(recordsPath, 'utf8');
  const rows = contents
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));

  if (rows.length !== catalog.sourceRecordCount) {
    throw new Error('Expected ' + catalog.sourceRecordCount + ' source rows but found ' + rows.length + '.');
  }

  const externalIds = rows
    .map(row => blankToNull(row.values[mapFields.beneficiaryId]))
    .filter(Boolean);
  if (externalIds.length !== rows.length || new Set(externalIds).size !== rows.length) {
    throw new Error('The workbook beneficiary IDs must all be present and unique before import.');
  }

  const coordinates = rows.filter(row => {
    const latitude = Number(row.values[mapFields.latitude]);
    const longitude = Number(row.values[mapFields.longitude]);
    return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
      Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
  });
  if (coordinates.length !== rows.length) {
    throw new Error('Expected valid GPS coordinates for every record; found ' + coordinates.length + ' of ' + rows.length + '.');
  }

  for (const row of rows) {
    for (const field of catalog.fields) {
      if (!Object.hasOwn(row.values, field.key)) {
        throw new Error('Source row ' + row.sourceRow + ' is missing field ' + field.key + '.');
      }
    }
  }
  return rows;
}

function createTableSql(tableNameToCreate) {
  const dataColumns = catalog.fields.map(field => {
    const type = field.key === mapFields.beneficiaryId ? 'NVARCHAR(255)' : 'NVARCHAR(MAX)';
    return quoteIdentifier(field.sqlName) + ' ' + type + ' NULL';
  });
  return 'CREATE TABLE ' + tableNameToCreate + ' (\n' +
    '  [RecordId] BIGINT IDENTITY(1,1) NOT NULL,\n' +
    '  [CreatedAt] DATETIME2(3) NOT NULL CONSTRAINT [DF_TeaFarmer_Records_Actual_CreatedAt] DEFAULT SYSUTCDATETIME(),\n' +
    '  ' + dataColumns.join(',\n  ') + ',\n' +
    '  CONSTRAINT [PK_TeaFarmer_Records_Actual_Load] PRIMARY KEY CLUSTERED ([RecordId])\n' +
    ');\n' +
    'CREATE UNIQUE INDEX [UX_TeaFarmer_Records_Actual_Load_BeneficiaryId]\n' +
    '  ON ' + tableNameToCreate + ' (' + sqlColumn(mapFields.beneficiaryId) + ')\n' +
    '  WHERE ' + sqlColumn(mapFields.beneficiaryId) + ' IS NOT NULL;';
}

async function insertRows(transaction, rows) {
  const fields = catalog.fields;
  const columnSql = fields.map(field => quoteIdentifier(field.sqlName)).join(', ');

  // SQL Server accepts at most 2,100 parameters per request. Two 919-field
  // records stay below that limit and keep the import parameterized.
  for (let start = 0; start < rows.length; start += 2) {
    const batch = rows.slice(start, start + 2);
    const request = new sql.Request(transaction);
    const tuples = batch.map((row, rowIndex) => {
      const placeholders = fields.map((field, columnIndex) => {
        const parameter = 'r' + rowIndex + 'c' + columnIndex;
        request.input(parameter, sql.NVarChar(sql.MAX), blankToNull(row.values[field.key]));
        return '@' + parameter;
      });
      return '(' + placeholders.join(', ') + ')';
    });

    await request.query(
      'INSERT INTO ' + stagingTableName + ' (' + columnSql + ')\n' +
      'VALUES ' + tuples.join(',\n')
    );
  }
}

async function main() {
  const rows = await readSourceRows();
  const pool = await poolPromise;
  const existing = await pool.request().query(
    "SELECT OBJECT_ID(N'" + tableName + "', N'U') AS currentTable, " +
    "OBJECT_ID(N'" + stagingTableName + "', N'U') AS stagingTable, " +
    "OBJECT_ID(N'" + backupTableName + "', N'U') AS backupTable"
  );
  const state = existing.recordset[0];

  if (state.backupTable) {
    throw new Error(backupTableName + ' already exists. Import stopped to protect the existing backup.');
  }
  if (!state.currentTable) {
    throw new Error(tableName + ' was not found. The test table was left untouched.');
  }

  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    if (state.stagingTable) {
      await new sql.Request(transaction).query('DROP TABLE ' + stagingTableName);
    }
    await new sql.Request(transaction).query(createTableSql(stagingTableName));
    await insertRows(transaction, rows);

    const validation = await new sql.Request(transaction).query(
      'SELECT COUNT_BIG(*) AS [rowCount], ' +
      'COUNT(DISTINCT CAST(' + sqlColumn(mapFields.beneficiaryId) + ' AS NVARCHAR(450))) AS uniqueBeneficiaryIds, ' +
      'COUNT(' + sqlColumn(mapFields.latitude) + ') AS latitudeCount, ' +
      'COUNT(' + sqlColumn(mapFields.longitude) + ') AS longitudeCount ' +
      'FROM ' + stagingTableName
    );
    const totals = validation.recordset[0];
    if (Number(totals.rowCount) !== catalog.sourceRecordCount ||
        Number(totals.uniqueBeneficiaryIds) !== catalog.sourceRecordCount ||
        Number(totals.latitudeCount) !== catalog.sourceRecordCount ||
        Number(totals.longitudeCount) !== catalog.sourceRecordCount) {
      throw new Error('Staging validation failed: ' + JSON.stringify(totals));
    }

    await new sql.Request(transaction).query(
      "EXEC sys.sp_rename N'" + tableName + "', N'TeaFarmer_Records_TestBackup', N'OBJECT';\n" +
      "EXEC sys.sp_rename N'" + stagingTableName + "', N'TeaFarmer_Records', N'OBJECT';"
    );
    await transaction.commit();

    console.log('Imported ' + totals.rowCount + ' records with ' + catalog.sourceFieldCount + ' source fields.');
    console.log('The former test table is retained as ' + backupTableName + ' for rollback.');
    console.log('RecordId is an automatically generated BIGINT identity; new questionnaire entries sort after imported rows.');
  } catch (error) {
    try { await transaction.rollback(); } catch { /* transaction may already be closed */ }
    throw error;
  }
}

main().catch(error => {
  console.error('Baseline import failed:', error.message);
  process.exitCode = 1;
});
