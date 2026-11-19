const { poolPromise, sql } = require('../db');
const { getActiveCatalog } = require('./activeCatalog');

function quoteIdentifier(identifier) {
  return '[' + identifier.replaceAll(']', ']]') + ']';
}

function getFieldMap(catalog) {
  return new Map(catalog.fields.map(field => [field.key, field]));
}

function getFullSelect(catalog) {
  const columns = [quoteIdentifier(catalog.recordIdColumn) + ' AS [RecordId]'];
  if (catalog.createdAtColumn) {
    columns.push(quoteIdentifier(catalog.createdAtColumn) + ' AS [CreatedAt]');
  }
  columns.push(...catalog.fields.map(field => quoteIdentifier(field.sqlName) + ' AS ' + quoteIdentifier(field.key)));
  return columns.join(', ');
}

function getRecordIdOrder(catalog) {
  const idColumn = quoteIdentifier(catalog.recordIdColumn);
  return catalog.recordIdIdentity
    ? idColumn + ' ASC'
    : 'TRY_CONVERT(BIGINT, ' + idColumn + ') ASC, ' + idColumn + ' ASC';
}

function getMapSelect(catalog) {
  const fieldsByKey = getFieldMap(catalog);
  const mapFieldKeys = [
    catalog.mapFields.enumerator,
    catalog.mapFields.date,
    catalog.mapFields.latitude,
    catalog.mapFields.longitude,
    catalog.mapFields.beneficiaryId,
    catalog.mapFields.district,
    catalog.mapFields.farmerName,
    catalog.mapFields.nic,
    catalog.mapFields.contact,
    catalog.mapFields.gender,
  ].filter(Boolean);
  return [
    quoteIdentifier(catalog.recordIdColumn) + ' AS [RecordId]',
    ...mapFieldKeys.map(key => quoteIdentifier(fieldsByKey.get(key).sqlName) + ' AS ' + quoteIdentifier(key)),
  ].join(', ');
}

function toMapRecord(row, catalog) {
  return {
    RecordId: row.RecordId,
    GEF_7_LD_BD_Projec: String(row.RecordId),
    Enumerator_name: catalog.mapFields.enumerator ? row[catalog.mapFields.enumerator] : null,
    Date: catalog.mapFields.date ? row[catalog.mapFields.date] : null,
    latitude: catalog.mapFields.latitude ? row[catalog.mapFields.latitude] : null,
    longitude: catalog.mapFields.longitude ? row[catalog.mapFields.longitude] : null,
    Beneficiary: catalog.mapFields.beneficiaryId ? row[catalog.mapFields.beneficiaryId] : null,
    district: catalog.mapFields.district ? row[catalog.mapFields.district] : null,
    Farmer_name: catalog.mapFields.farmerName ? row[catalog.mapFields.farmerName] : null,
    NIC_No: catalog.mapFields.nic ? row[catalog.mapFields.nic] : null,
    contact_No: catalog.mapFields.contact ? row[catalog.mapFields.contact] : null,
    Gender: catalog.mapFields.gender ? row[catalog.mapFields.gender] : null,
  };
}

const getAllTeaFarmers = async () => {
  const catalog = getActiveCatalog();
  const pool = await poolPromise;
  const result = await pool.request().query(
    'SELECT ' + getMapSelect(catalog) +
    ' FROM dbo.TeaFarmer_Records ORDER BY ' + getRecordIdOrder(catalog)
  );
  return result.recordset.map(row => toMapRecord(row, catalog));
};

const getAllTeaFarmersForExport = async () => {
  const catalog = getActiveCatalog();
  const pool = await poolPromise;
  const result = await pool.request().query(
    'SELECT ' + getFullSelect(catalog) +
    ' FROM dbo.TeaFarmer_Records ORDER BY ' + getRecordIdOrder(catalog)
  );
  return result.recordset;
};

const getTeaFarmerById = async id => {
  const catalog = getActiveCatalog();
  const pool = await poolPromise;
  const result = await pool.request()
    .input('id', sql.BigInt, id)
    .query(
      'SELECT ' + getFullSelect(catalog) +
      ' FROM dbo.TeaFarmer_Records WHERE ' + quoteIdentifier(catalog.recordIdColumn) + ' = @id'
    );
  return result.recordset[0] || null;
};

module.exports = {
  getAllTeaFarmers,
  getAllTeaFarmersForExport,
  getTeaFarmerById,
};
