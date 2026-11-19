const { poolPromise } = require('../db');
const actualCatalog = require('../data/baselineFieldCatalog.json');
const testCatalog = require('../data/testFieldCatalog.json');

let activeCatalog = null;

async function initializeActiveCatalog() {
  const pool = await poolPromise;
  const result = await pool.request().query(
    "SELECT [name], [is_identity] FROM sys.columns " +
    "WHERE [object_id] = OBJECT_ID(N'dbo.TeaFarmer_Records', N'U')"
  );
  const columnNames = new Set(result.recordset.map(column => column.name));

  const actualMatches = columnNames.has(actualCatalog.recordIdColumn) &&
    columnNames.has(actualCatalog.fields[0].sqlName);
  const testMatches = columnNames.has(testCatalog.recordIdColumn) &&
    columnNames.has(testCatalog.fields[1].sqlName);

  if (actualMatches === testMatches) {
    throw new Error('Could not identify the active TeaFarmer_Records schema from its columns.');
  }

  const selectedCatalog = actualMatches ? actualCatalog : testCatalog;
  const recordIdMetadata = result.recordset.find(column => column.name === selectedCatalog.recordIdColumn);
  activeCatalog = {
    ...selectedCatalog,
    recordIdIdentity: Boolean(recordIdMetadata?.is_identity),
  };
  console.log('Using ' + activeCatalog.profile + ' data schema (' + activeCatalog.fields.length + ' fields).');
  return activeCatalog;
}

function getActiveCatalog() {
  if (!activeCatalog) {
    throw new Error('The active database schema has not been initialized.');
  }
  return activeCatalog;
}

module.exports = { getActiveCatalog, initializeActiveCatalog };
