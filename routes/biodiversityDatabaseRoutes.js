const express = require('express');
const { poolPromise, sql } = require('../db');

const router = express.Router();

// This page is intentionally limited to the two Biodiversity tables already used by reports.
const TABLE_OPTIONS = [
  { name: 'All_Species', label: 'All species master dataset', description: 'National species reference dataset' },
  { name: 'Galle_Biodiversity', label: 'Galle biodiversity records', description: 'Survey observations for Galle' },
];

const PAGE_SIZE_DEFAULT = 100;
const PAGE_SIZE_MAX = 200;
const SEARCHABLE_TYPES = new Set([
  'char', 'varchar', 'nchar', 'nvarchar', 'text', 'ntext',
  'tinyint', 'smallint', 'int', 'bigint', 'decimal', 'numeric',
  'float', 'real', 'money', 'smallmoney', 'bit', 'date', 'datetime',
  'datetime2', 'smalldatetime', 'datetimeoffset', 'time', 'uniqueidentifier',
]);

const quoteIdentifier = value => '[' + String(value).replaceAll(']', ']]') + ']';
const qualifiedName = table => `${quoteIdentifier(table.schemaName)}.${quoteIdentifier(table.tableName)}`;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizeTableName(value) {
  return String(value || '').toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
}

async function findAllowedTable(pool, requestedName) {
  const option = TABLE_OPTIONS.find(table => normalizeTableName(table.name) === normalizeTableName(requestedName));
  if (!option) throw new RequestError(404, 'Choose one of the available Biodiversity tables.');

  const result = await pool.request()
    .input('tableName', sql.NVarChar(128), option.name)
    .query(`
      SELECT TOP (1) s.name AS schemaName, t.name AS tableName
      FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE t.name = @tableName
      ORDER BY CASE WHEN s.name = 'dbo' THEN 0 ELSE 1 END
    `);

  if (!result.recordset[0]) throw new RequestError(404, `${option.name} is not available in the connected database.`);
  return { ...result.recordset[0], label: option.label, description: option.description };
}

async function readColumns(pool, table) {
  const result = await pool.request()
    .input('schemaName', sql.NVarChar(128), table.schemaName)
    .input('tableName', sql.NVarChar(128), table.tableName)
    .query(`
      SELECT
        c.column_id AS columnId,
        c.name AS columnName,
        TYPE_NAME(c.user_type_id) AS dataType,
        c.max_length AS maxLength,
        c.precision AS precision,
        c.scale AS scale,
        c.is_nullable AS isNullable,
        c.is_identity AS isIdentity,
        c.is_computed AS isComputed,
        c.generated_always_type AS generatedAlwaysType,
        c.default_object_id AS defaultObjectId,
        COALESCE(pk.key_ordinal, 0) AS keyOrdinal
      FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.columns c ON c.object_id = t.object_id
      LEFT JOIN (
        SELECT ic.object_id, ic.column_id, ic.key_ordinal
        FROM sys.indexes i
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        WHERE i.is_primary_key = 1 AND ic.key_ordinal > 0
      ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
      WHERE s.name = @schemaName AND t.name = @tableName
      ORDER BY c.column_id
    `);

  return result.recordset.map(column => ({
    name: column.columnName,
    dataType: column.dataType,
    maxLength: column.maxLength,
    precision: column.precision,
    scale: column.scale,
    nullable: Boolean(column.isNullable),
    identity: Boolean(column.isIdentity),
    computed: Boolean(column.isComputed),
    generated: column.generatedAlwaysType !== 0,
    hasDefault: column.defaultObjectId !== 0,
    primaryKeyOrder: Number(column.keyOrdinal),
    editable: !column.isIdentity && !column.isComputed && column.generatedAlwaysType === 0 && !['timestamp', 'rowversion'].includes(String(column.dataType).toLowerCase()),
  }));
}

function writableColumns(columns) {
  return columns.filter(column => column.editable);
}

function toParameterValue(value, column) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (String(column?.dataType).toLowerCase() === 'bit') {
    return ['1', 'true', 'yes', 'y'].includes(String(value).toLowerCase()) ? '1' : '0';
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function bindRowLocator(request, locatorColumns, originalRow) {
  if (!originalRow || typeof originalRow !== 'object' || Array.isArray(originalRow)) {
    throw new RequestError(400, 'The original row values are required.');
  }

  const predicates = locatorColumns.map((column, index) => {
    if (!Object.hasOwn(originalRow, column.name)) {
      throw new RequestError(400, 'The original row is missing values needed to identify it. Refresh the table and try again.');
    }

    const value = originalRow[column.name];
    if (value === null || value === undefined) return `${quoteIdentifier(column.name)} IS NULL`;
    const parameter = `row_${index}`;
    request.input(parameter, sql.NVarChar(sql.MAX), toParameterValue(value, column));
    return `${quoteIdentifier(column.name)} = @${parameter}`;
  });

  return predicates.join(' AND ');
}

function getLocatorColumns(columns) {
  const primaryKey = columns.filter(column => column.primaryKeyOrder > 0)
    .sort((left, right) => left.primaryKeyOrder - right.primaryKeyOrder);

  // Imported spreadsheets may not have a primary key; in that case the complete original row is the locator.
  return primaryKey.length ? primaryKey : columns;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function buildSearchClause(request, columns, searchText) {
  const query = String(searchText || '').trim().slice(0, 300);
  if (!query) return '';

  const searchable = columns.filter(column => SEARCHABLE_TYPES.has(String(column.dataType).toLowerCase()));
  if (!searchable.length) return '';

  request.input('search', sql.NVarChar(4000), `%${query}%`);
  return ' WHERE (' + searchable.map(column =>
    `TRY_CONVERT(nvarchar(max), ${quoteIdentifier(column.name)}) LIKE @search`
  ).join(' OR ') + ')';
}

function buildOrderBy(columns, sortColumn, direction) {
  const primaryKey = columns.filter(column => column.primaryKeyOrder > 0)
    .sort((left, right) => left.primaryKeyOrder - right.primaryKeyOrder);
  const selectedSort = columns.find(column => column.name === sortColumn);
  const primaryKeys = primaryKey.length ? primaryKey : [columns[0]].filter(Boolean);
  const orderColumns = selectedSort ? [selectedSort, ...primaryKeys.filter(column => column.name !== selectedSort.name)] : primaryKeys;
  const orderDirection = String(direction).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  return orderColumns.length
    ? ' ORDER BY ' + orderColumns.map((column, index) => `${quoteIdentifier(column.name)} ${index === 0 ? orderDirection : 'ASC'}`).join(', ')
    : ' ORDER BY (SELECT NULL)';
}

async function updateOrDeleteOneRow(pool, table, columns, originalRow, operation) {
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  let transactionOpen = true;

  try {
    const locatorColumns = getLocatorColumns(columns);
    const countRequest = transaction.request();
    const where = bindRowLocator(countRequest, locatorColumns, originalRow);
    const countResult = await countRequest.query(
      `SELECT COUNT_BIG(*) AS matchCount FROM ${qualifiedName(table)} WITH (UPDLOCK, HOLDLOCK) WHERE ${where}`
    );
    const matchCount = Number(countResult.recordset[0].matchCount);

    if (matchCount === 0) throw new RequestError(409, 'This row has changed or was removed. Refresh the table and try again.');
    if (matchCount > 1) throw new RequestError(409, 'This table has duplicate rows with no unique key. This row cannot be changed safely.');

    const result = await operation(transaction, where, locatorColumns, originalRow);
    if (result.rowsAffected?.[0] !== 1) throw new RequestError(409, 'The row could not be changed. Refresh the table and try again.');

    await transaction.commit();
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      await transaction.rollback().catch(() => {});
      transactionOpen = false;
    }
    throw error;
  }
}

async function listAvailableTables(pool) {
  const result = await pool.request().query('SELECT t.name AS tableName FROM sys.tables t');
  const present = new Set(result.recordset.map(row => normalizeTableName(row.tableName)));
  return TABLE_OPTIONS.filter(table => present.has(normalizeTableName(table.name)));
}

router.get('/tables', async (req, res) => {
  try {
    const pool = await poolPromise;
    return res.json({ status: 'success', data: { tables: await listAvailableTables(pool) } });
  } catch (error) {
    console.error('Could not list Biodiversity database tables:', error);
    return res.status(500).json({ status: 'error', message: 'Could not load the available Biodiversity tables.' });
  }
});

router.get('/:tableName/export', async (req, res) => {
  try {
    const pool = await poolPromise;
    const table = await findAllowedTable(pool, req.params.tableName);
    const columns = await readColumns(pool, table);
    const result = await pool.request().query(`SELECT * FROM ${qualifiedName(table)}${buildOrderBy(columns)}`);
    return res.json({ status: 'success', data: { table, columns, rows: result.recordset } });
  } catch (error) {
    if (error instanceof RequestError) return res.status(error.status).json({ status: 'error', message: error.message });
    console.error('Could not export Biodiversity database table:', error);
    return res.status(500).json({ status: 'error', message: 'Could not prepare the full table download.' });
  }
});

router.get('/:tableName', async (req, res) => {
  try {
    const pool = await poolPromise;
    const table = await findAllowedTable(pool, req.params.tableName);
    const columns = await readColumns(pool, table);
    const page = parsePositiveInteger(req.query.page, 1);
    const pageSize = Math.min(parsePositiveInteger(req.query.pageSize, PAGE_SIZE_DEFAULT), PAGE_SIZE_MAX);
    const countRequest = pool.request();
    const countFilter = buildSearchClause(countRequest, columns, req.query.search);
    const countResult = await countRequest.query(`SELECT COUNT_BIG(*) AS totalRows FROM ${qualifiedName(table)}${countFilter}`);
    const totalRows = Number(countResult.recordset[0].totalRows);

    const rowsRequest = pool.request();
    const rowsFilter = buildSearchClause(rowsRequest, columns, req.query.search);
    const offset = (page - 1) * pageSize;
    rowsRequest.input('offset', sql.Int, offset);
    rowsRequest.input('pageSize', sql.Int, pageSize);
    const result = await rowsRequest.query(
      `SELECT * FROM ${qualifiedName(table)}${rowsFilter}${buildOrderBy(columns, req.query.sort, req.query.direction)} OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`
    );

    return res.json({
      status: 'success',
      data: {
        table,
        columns,
        rows: result.recordset,
        page,
        pageSize,
        totalRows,
        totalPages: Math.max(1, Math.ceil(totalRows / pageSize)),
      },
    });
  } catch (error) {
    if (error instanceof RequestError) return res.status(error.status).json({ status: 'error', message: error.message });
    console.error('Could not load Biodiversity database table:', error);
    return res.status(500).json({ status: 'error', message: 'Could not load this table from SQL Server.' });
  }
});

router.post('/:tableName', async (req, res) => {
  try {
    const pool = await poolPromise;
    const table = await findAllowedTable(pool, req.params.tableName);
    const columns = writableColumns(await readColumns(pool, table));
    const values = req.body?.values;
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new RequestError(400, 'Enter values for the new row.');
    }

    const unknownFields = Object.keys(values).filter(name => !columns.some(column => column.name === name));
    if (unknownFields.length) throw new RequestError(400, 'The row contains fields that cannot be edited. Refresh the table and try again.');

    const providedColumns = columns.filter(column => Object.hasOwn(values, column.name));
    const request = pool.request();
    const tableName = qualifiedName(table);
    let query;

    if (!providedColumns.length) {
      query = `INSERT INTO ${tableName} OUTPUT INSERTED.* DEFAULT VALUES`;
    } else {
      const names = providedColumns.map(column => quoteIdentifier(column.name));
      const parameters = providedColumns.map((column, index) => {
        const parameter = `value_${index}`;
        request.input(parameter, sql.NVarChar(sql.MAX), toParameterValue(values[column.name], column));
        return `@${parameter}`;
      });
      query = `INSERT INTO ${tableName} (${names.join(', ')}) OUTPUT INSERTED.* VALUES (${parameters.join(', ')})`;
    }

    const result = await request.query(query);
    return res.status(201).json({ status: 'success', data: { row: result.recordset[0] } });
  } catch (error) {
    if (error instanceof RequestError) return res.status(error.status).json({ status: 'error', message: error.message });
    console.error('Could not add Biodiversity database row:', error);
    return res.status(400).json({ status: 'error', message: 'Could not add this row. Check required fields and data types.' });
  }
});

router.patch('/:tableName', async (req, res) => {
  try {
    const pool = await poolPromise;
    const table = await findAllowedTable(pool, req.params.tableName);
    const columns = await readColumns(pool, table);
    const editable = writableColumns(columns);
    const changes = req.body?.changes;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) {
      throw new RequestError(400, 'Make at least one change before saving.');
    }

    const unknownFields = Object.keys(changes).filter(name => !editable.some(column => column.name === name));
    if (unknownFields.length) throw new RequestError(400, 'One or more selected fields cannot be edited. Refresh the table and try again.');

    await updateOrDeleteOneRow(pool, table, columns, req.body.originalRow, async (transaction, where, locatorColumns, originalRow) => {
      const request = transaction.request();
      const whereClause = bindRowLocator(request, locatorColumns, originalRow);
      const assignments = Object.entries(changes).map(([name, value], index) => {
        const parameter = `change_${index}`;
        request.input(parameter, sql.NVarChar(sql.MAX), toParameterValue(value, editable.find(column => column.name === name)));
        return `${quoteIdentifier(name)} = @${parameter}`;
      });
      return request.query(`UPDATE ${qualifiedName(table)} SET ${assignments.join(', ')} WHERE ${whereClause}`);
    });

    return res.json({ status: 'success', message: 'Row updated.' });
  } catch (error) {
    if (error instanceof RequestError) return res.status(error.status).json({ status: 'error', message: error.message });
    console.error('Could not update Biodiversity database row:', error);
    return res.status(400).json({ status: 'error', message: 'Could not save this row. Check required fields and data types.' });
  }
});

router.delete('/:tableName', async (req, res) => {
  try {
    const pool = await poolPromise;
    const table = await findAllowedTable(pool, req.params.tableName);
    const columns = await readColumns(pool, table);

    await updateOrDeleteOneRow(pool, table, columns, req.body?.originalRow, async (transaction, where, locatorColumns, originalRow) => {
      const request = transaction.request();
      const whereClause = bindRowLocator(request, locatorColumns, originalRow);
      return request.query(`DELETE FROM ${qualifiedName(table)} WHERE ${whereClause}`);
    });

    return res.json({ status: 'success', message: 'Row deleted.' });
  } catch (error) {
    if (error instanceof RequestError) return res.status(error.status).json({ status: 'error', message: error.message });
    console.error('Could not delete Biodiversity database row:', error);
    return res.status(500).json({ status: 'error', message: 'Could not delete this row from SQL Server.' });
  }
});

module.exports = router;
