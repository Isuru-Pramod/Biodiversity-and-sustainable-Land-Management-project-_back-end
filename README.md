# WebGIS backend

## Import the full tea-farmer baseline

The import preserves the workbook's complete Master_Clean schema and replaces
the active test table only after a staged import passes row, ID, and GPS checks.
The previous table is retained as dbo.TeaFarmer_Records_TestBackup.

1. Prepare the workbook fields and local private import payload:

   python scripts/prepareActualBaseline.py "D:\data_Input web\Productivity improvement_Tea Small holder_base_line.xlsx"

   The generated respondent rows are stored under private-data/, which is
   excluded by .gitignore.

2. Run the import from the Windows account that owns the
   (localdb)\MSSQLLocalDB instance:

   npm run import:baseline

3. Restart the backend and frontend so the updated API and field catalog load.

The SQL database remains WebGIS_DB. RecordId is the generated SQL identity;
the workbook Beneficiary / Record ID remains a separate source field.

## Restore the original 45-field test table

The original table is retained as `dbo.TeaFarmer_Records_TestBackup` after an
actual-baseline import. To switch back without deleting either dataset:

1. Stop the backend so it is not querying the table during the rename.
2. From this directory, run `npm run restore:test-table` in the Windows account
   that owns `(localdb)\MSSQLLocalDB`.
3. Start the backend with `npm run dev`.

The restore command verifies that the saved test table has 45 columns and the
record ID column before swapping it back. If that column is not a SQL identity,
the app generates the next numeric ID while locking concurrent submissions.
The actual baseline is kept as
`dbo.TeaFarmer_Records_Actual_Backup`. On startup, the backend detects which
schema is active and serves the matching questionnaire, map, database table,
and pivot fields.
