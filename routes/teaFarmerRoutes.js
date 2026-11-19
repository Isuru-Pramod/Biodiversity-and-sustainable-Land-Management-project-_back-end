const express = require('express');
const router = express.Router();
const { sql, poolPromise } = require('../db');
const { getActiveCatalog } = require('../models/activeCatalog');

const {
  getAllTeaFarmers,
  getAllTeaFarmersForExport,
  getTeaFarmerById,
} = require('../models/TeaFarmer');

function quoteIdentifier(identifier) {
  return '[' + identifier.replaceAll(']', ']]') + ']';
}

function escapeCsvValue(value) {
  let text = value instanceof Date
    ? value.toISOString()
    : value === null || value === undefined
      ? ''
      : String(value);
  const numericValue = /^-?\d+(?:\.\d+)?$/.test(text.trim());
  if (!numericValue && /^[\s]*[=+@]/.test(text)) text = "'" + text;
  if (!numericValue && /^[\s]*-[A-Za-z=+@]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

function getCsvColumns(catalog) {
  if (catalog.recordIdField) {
    return catalog.fields.map(field => ({ key: field.key, label: field.displayLabel }));
  }
  return [
    { key: 'RecordId', label: 'Record ID' },
    ...(catalog.createdAtColumn ? [{ key: 'CreatedAt', label: 'Created At' }] : []),
    ...catalog.fields.map(field => ({ key: field.key, label: field.displayLabel })),
  ];
}

router.get('/schema', (req, res) => {
  const catalog = getActiveCatalog();
  return res.status(200).json({ status: 'success', data: catalog });
});

// Explicit full-table download includes the fields the user requested.
router.get('/export', async (req, res) => {
  try {
    const catalog = getActiveCatalog();
    const rows = await getAllTeaFarmersForExport();
    const columns = getCsvColumns(catalog);
    const lines = [
      columns.map(column => escapeCsvValue(column.label)).join(','),
      ...rows.map(row => columns.map(column => escapeCsvValue(row[column.key])).join(',')),
    ];
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="TeaGrow_database_' + date + '.csv"');
    return res.status(200).send('\uFEFF' + lines.join('\r\n'));
  } catch (error) {
    console.error('Error exporting tea farmer records:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Unable to export the database.',
    });
  }
});

router.get('/database', async (req, res) => {
  try {
    const catalog = getActiveCatalog();
    const farmers = await getAllTeaFarmersForExport();
    return res.status(200).json({
      status: 'success',
      count: farmers.length,
      fieldCount: catalog.fields.length,
      features: farmers,
    });
  } catch (error) {
    console.error('Error retrieving database records:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Unable to retrieve database records.',
    });
  }
});

// Map includes the identifiers explicitly requested for the map popups.
router.get('/map', async (req, res) => {
  try {
    const farmers = await getAllTeaFarmers();
    return res.status(200).json({
      status: 'success',
      count: farmers.length,
      features: farmers,
    });
  } catch (error) {
    console.error('Error retrieving map records:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Unable to retrieve map records.',
    });
  }
});

router.post('/', async (req, res) => {
  const catalog = getActiveCatalog();
  const fieldsByKey = new Map(catalog.fields.map(field => [field.key, field]));
  const inputFields = catalog.fields.filter(field => field.input);
  const answers = req.body?.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return res.status(400).json({ status: 'error', message: 'Questionnaire answers are required.' });
  }

  const unknownFields = Object.keys(answers).filter(key => !fieldsByKey.has(key) || !fieldsByKey.get(key).input);
  if (unknownFields.length) {
    return res.status(400).json({
      status: 'error',
      message: 'The submitted questionnaire contains unsupported fields.',
    });
  }

  const missing = inputFields
    .filter(field => field.required)
    .filter(field => answers[field.key] === undefined || answers[field.key] === null || String(answers[field.key]).trim() === '')
    .map(field => field.displayLabel);
  if (missing.length) {
    return res.status(400).json({
      status: 'error',
      message: 'Required fields are missing: ' + missing.join(', '),
    });
  }

  const latitude = Number(answers[catalog.mapFields.latitude]);
  const longitude = Number(answers[catalog.mapFields.longitude]);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return res.status(400).json({
      status: 'error',
      message: 'Enter valid latitude and longitude coordinates.',
    });
  }

  const submittedFields = inputFields.filter(field => Object.hasOwn(answers, field.key));
  try {
    const pool = await poolPromise;
    const transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

    let recordId;
    try {
      const columns = [];
      const parameters = [];
      const request = new sql.Request(transaction);

      if (!catalog.recordIdIdentity) {
        await new sql.Request(transaction).query(
          "DECLARE @lockResult int; " +
          "EXEC @lockResult = sys.sp_getapplock " +
          "@Resource = N'WebGIS_TeaFarmer_RecordId', " +
          "@LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 10000; " +
          "IF @lockResult < 0 RAISERROR('Could not lock record ID generation.', 16, 1);"
        );

        const maxResult = await new sql.Request(transaction).query(
          'SELECT COALESCE(MAX(TRY_CONVERT(BIGINT, ' + quoteIdentifier(catalog.recordIdColumn) + ')), 0) AS [maxId] ' +
          'FROM dbo.TeaFarmer_Records WITH (UPDLOCK, HOLDLOCK)'
        );
        const maxId = Number(maxResult.recordset[0].maxId);
        if (!Number.isSafeInteger(maxId) || maxId < 0) {
          throw new Error('Could not determine the next test-table record ID.');
        }

        const generatedId = maxId + 1;
        const idParameter = 'generatedRecordId';
        request.input(idParameter, sql.NVarChar(50), String(generatedId));
        columns.push(quoteIdentifier(catalog.recordIdColumn));
        parameters.push('@' + idParameter);
      }

      submittedFields.forEach((field, index) => {
        const parameter = 'answer' + index;
        const rawValue = answers[field.key];
        const text = rawValue === null || rawValue === undefined || String(rawValue).trim() === ''
          ? null
          : String(rawValue).trim();
        request.input(parameter, sql.NVarChar(sql.MAX), text);
        columns.push(quoteIdentifier(field.sqlName));
        parameters.push('@' + parameter);
      });

      const result = await request.query(
        'INSERT INTO dbo.TeaFarmer_Records (' + columns.join(', ') + ') ' +
        'OUTPUT INSERTED.' + quoteIdentifier(catalog.recordIdColumn) + ' AS recordId VALUES (' + parameters.join(', ') + ')'
      );
      recordId = result.recordset[0].recordId;

      await transaction.commit();
    } catch (transactionError) {
      try { await transaction.rollback(); } catch { /* transaction may already be closed */ }
      throw transactionError;
    }

    return res.status(201).json({
      status: 'success',
      message: 'Questionnaire response saved.',
      recordId,
    });
  } catch (error) {
    console.error('Error saving questionnaire response:', error);
    if (error.number === 2601 || error.number === 2627) {
      return res.status(409).json({
        status: 'error',
        message: 'A duplicate beneficiary record ID was submitted.',
      });
    }
    return res.status(500).json({
      status: 'error',
      message: 'Unable to save the questionnaire response.',
    });
  }
});

router.get('/', async (req, res) => {
  try {
    const farmers = await getAllTeaFarmers();
    return res.status(200).json({
      status: 'success',
      count: farmers.length,
      features: farmers,
    });
  } catch (error) {
    console.error('Error retrieving tea farmers:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Unable to retrieve tea farmer records.',
    });
  }
});

router.get('/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ status: 'error', message: 'Record ID must be numeric.' });
  }

  try {
    const farmer = await getTeaFarmerById(id);
    if (!farmer) {
      return res.status(404).json({ status: 'error', message: 'Farmer record not found.' });
    }
    return res.status(200).json({ status: 'success', data: farmer });
  } catch (error) {
    console.error('Error retrieving farmer:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Unable to retrieve farmer record.',
    });
  }
});

module.exports = router;
