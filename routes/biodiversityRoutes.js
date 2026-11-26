const express = require('express');
const { poolPromise } = require('../db');
const { isGeographicGeometry, wktToGeoJson } = require('../utils/wktToGeoJson');

const router = express.Router();

function normalizeLabel(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeColumn(value) {
  return String(value ?? '').toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
}

// Quote discovered SQL identifiers so table and column names with spaces remain safe to query.
function quoteIdentifier(value) {
  return '[' + String(value).replaceAll(']', ']]') + ']';
}

function readField(row, aliases) {
  const indexed = new Map(Object.entries(row).map(([key, value]) => [normalizeColumn(key), value]));
  for (const alias of aliases) {
    const value = indexed.get(normalizeColumn(alias));
    if (value !== undefined) return value;
  }
  return null;
}

function readFieldContaining(row, text) {
  const normalizedNeedle = normalizeColumn(text);
  const match = Object.entries(row).find(([key]) => normalizeColumn(key).includes(normalizedNeedle));
  return match ? match[1] : null;
}

function hasPopulatedField(rows, text) {
  const normalizedNeedle = normalizeColumn(text);
  const field = Object.keys(rows[0] || {}).find(key => normalizeColumn(key).includes(normalizedNeedle));
  return Boolean(field && rows.some(row => row[field] !== null && row[field] !== undefined && String(row[field]).trim() !== ''));
}

function taxonPairKey(genus, species) {
  // A control-character separator avoids collisions when taxon name parts contain spaces or punctuation.
  return normalizeLabel(genus) + '\u001f' + normalizeLabel(species);
}

function taxonKey(genus, species, subspecies) {
  return taxonPairKey(genus, species) + '\u001f' + normalizeLabel(subspecies);
}

function toStringOrNull(value) {
  return value === null || value === undefined || String(value).trim() === '' ? null : String(value).trim();
}

function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function resolveGroup(groupValue, floraFauna) {
  const group = normalizeColumn(groupValue);
  const known = [
    ['dragonflies', ['dragonfly', 'dragonflies', 'odonata']],
    ['butterflies', ['butterfly', 'butterflies', 'lepidoptera']],
    ['freshwater fish', ['fish', 'freshwaterfish', 'freshwaterfishes']],
    ['amphibians', ['amphibian', 'amphibians']],
    ['reptiles', ['reptile', 'reptiles']],
    ['birds', ['bird', 'birds', 'aves']],
    ['mammals', ['mammal', 'mammals']],
    ['plants', ['plant', 'plants', 'flora']],
  ];
  const match = known.find(([, names]) => names.includes(group));
  if (match) return match[0];

  const flora = normalizeColumn(floraFauna);
  if (flora.includes('flora') || flora.includes('plant')) return 'plants';
  if (flora.includes('fauna')) return 'unmatched';
  return 'unmatched';
}

function chooseTable(tables, expectedName) {
  const wanted = normalizeColumn(expectedName);
  const matches = tables.filter(table => normalizeColumn(table.tableName) === wanted);
  // Prefer dbo when similarly named tables exist in multiple schemas.
  return matches.find(table => normalizeLabel(table.schemaName) === 'dbo') || matches[0] || null;
}

// The input workbooks use changing column labels, so discovery and alias matching keep the API schema-tolerant.
async function getTables(pool) {
  const result = await pool.request().query(`
    SELECT s.name AS schemaName, t.name AS tableName
    FROM sys.tables AS t
    INNER JOIN sys.schemas AS s ON s.schema_id = t.schema_id
  `);
  return result.recordset;
}

async function readTable(pool, table) {
  return pool.request().query(
    'SELECT * FROM ' + quoteIdentifier(table.schemaName) + '.' + quoteIdentifier(table.tableName)
  ).then(result => result.recordset);
}

function normalizeEstateCode(value) {
  const code = toStringOrNull(value);
  if (!code) return null;
  return code.replace(/\.0+$/, '').replace(/\s+/g, '').toLocaleUpperCase();
}

function geometryFromRow(row) {
  return readField(row, ['AS_WKT', 'WKT', 'Geometry', 'Shape WKT']) ?? readFieldContaining(row, 'AS_WKT');
}

function makeEstateFeature(row, index) {
  // Biodiversity rows use Es_code; estate boundary rows store the matching key as Estate_cod.
  const estateCode = toStringOrNull(readField(row, ['Estate_cod', 'Estate cod', 'Estate Code', 'EstateCode', 'Es_code', 'Es Code']));
  const geometry = wktToGeoJson(String(geometryFromRow(row) ?? ''));
  if (!geometry || !isGeographicGeometry(geometry)) return null;

  return {
    type: 'Feature',
    properties: {
      mapId: `estate-${normalizeEstateCode(estateCode) || index}`,
      estateCode,
      estateName: toStringOrNull(readField(row, ['Estate', 'Estate Name', 'EstateName', 'Es_name', 'Name'])) || estateCode || `Estate ${index + 1}`,
    },
    geometry,
  };
}

function makeDistrictFeature(row, index) {
  const geometry = wktToGeoJson(String(geometryFromRow(row) ?? ''));
  if (!geometry || !isGeographicGeometry(geometry)) return null;

  return {
    type: 'Feature',
    properties: {
      mapId: `district-${index}`,
      districtName: toStringOrNull(readField(row, ['District', 'District Name', 'NAME_2', 'Name', 'NAME'])) || 'Galle District',
    },
    geometry,
  };
}

function normalizeReferenceRows(rows) {
  return rows.map(row => {
    const genus = toStringOrNull(readField(row, ['Genus']));
    const species = toStringOrNull(readField(row, ['Species']));
    const subspecies = toStringOrNull(readField(row, ['Subspecies', 'Sub species']));
    return {
      genus,
      species,
      subspecies,
      group: resolveGroup(readField(row, ['Group', 'Taxon Group']), readField(row, ['FloraOrFauna', 'Flora Or Fauna'])),
      order: toStringOrNull(readField(row, ['Order'])),
      family: toStringOrNull(readField(row, ['Family'])),
      englishName: toStringOrNull(readField(row, ['English Name', 'EnglishName'])),
      sinhalaName: toStringOrNull(readField(row, ['Sinhala Name', 'SinhalaName'])),
      habit: toStringOrNull(readField(row, ['Habit'])),
      taxonomicStatus: toStringOrNull(readField(row, ['Taxonomic Status', 'TaxonomicStatus'])),
      nationalStatus: toStringOrNull(readField(row, ['National Conservation Status', 'National Status'])),
      globalStatus: toStringOrNull(readField(row, ['Global Conservation Status', 'Global Status'])),
      invasiveAlienStatus: toStringOrNull(readField(row, [
        "Invasive Alien Species (if so 'Yes')",
        'Invasive Alien Species',
        'IAS',
      ])),
      flagshipStatus: toStringOrNull(readField(row, ['Flagship', 'Flagship Species', 'Flagship Status']) ?? readFieldContaining(row, 'Flagship')),
    };
  }).filter(row => row.genus && row.species);
}

function attachReference(observations, references) {
  const exact = new Map();
  const bySpecies = new Map();
  for (const reference of references) {
    const fullKey = taxonKey(reference.genus, reference.species, reference.subspecies);
    if (!exact.has(fullKey)) exact.set(fullKey, reference);
    const pair = taxonPairKey(reference.genus, reference.species);
    const candidates = bySpecies.get(pair) || [];
    candidates.push(reference);
    bySpecies.set(pair, candidates);
  }

  const matchCounts = { exact: 0, speciesFallback: 0, unmatched: 0, missingTaxon: 0 };
  const normalized = observations.map(row => {
    const genus = toStringOrNull(readField(row, ['Genus']));
    const species = toStringOrNull(readField(row, ['Species']));
    const subspecies = toStringOrNull(readField(row, ['Subspecies', 'Sub species']));
    // Prefer a full genus/species/subspecies match; use genus/species only when exactly one reference qualifies.
    const exactMatch = genus && species ? exact.get(taxonKey(genus, species, subspecies)) : null;
    const candidates = genus && species ? bySpecies.get(taxonPairKey(genus, species)) || [] : [];
    const fallbackMatch = !exactMatch && candidates.length === 1 ? candidates[0] : null;
    const reference = exactMatch || fallbackMatch;
    const matchType = !genus || !species
      ? 'missingTaxon'
      : exactMatch
        ? 'exact'
        : fallbackMatch
          ? 'speciesFallback'
          : 'unmatched';
    matchCounts[matchType] += 1;

    const yearValue = readField(row, ['Year', 'Survey Year', 'SurveyYear']);
    const yearText = toStringOrNull(yearValue);
    const yearMatch = yearText?.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch ? Number(yearMatch[0]) : null;

    return {
      district: toStringOrNull(readField(row, ['District'])),
      plc: toStringOrNull(readField(row, ['PLC'])),
      estate: toStringOrNull(readField(row, ['Estate'])) || 'Unassigned estate',
      latitude: toFiniteNumberOrNull(readField(row, ['Latitude', 'Lat'])),
      longitude: toFiniteNumberOrNull(readField(row, ['Longitude', 'Long', 'Lon'])),
      genus,
      species,
      subspecies,
      scientificName: [genus, species].filter(Boolean).join(' '),
      speciesKey: genus && species ? taxonPairKey(genus, species) : null,
      surveyYear: year,
      source: toStringOrNull(readField(row, ['Source'])),
      estateCode: toStringOrNull(readField(row, ['Es_code', 'Estate Code', 'EstateCode', 'Es Code'])),
      patchCode: toStringOrNull(readField(row, ['Patch_code', 'Patch Code'])),
      group: reference?.group || resolveGroup(readField(row, ['Group', 'Taxon Group']), readField(row, ['FloraOrFauna', 'Flora Or Fauna'])),
      order: reference?.order || null,
      family: reference?.family || null,
      englishName: reference?.englishName || null,
      sinhalaName: reference?.sinhalaName || null,
      habit: reference?.habit || null,
      taxonomicStatus: reference?.taxonomicStatus || null,
      nationalStatus: reference?.nationalStatus || null,
      globalStatus: reference?.globalStatus || null,
      invasiveAlienStatus: reference?.invasiveAlienStatus || null,
      flagshipStatus: reference?.flagshipStatus || null,
      referenceMatch: matchType,
    };
  });

  return { observations: normalized, matchCounts };
}

router.get('/map-data', async (req, res) => {
  try {
    const pool = await poolPromise;
    const tables = await getTables(pool);
    const observationsTable = chooseTable(tables, 'Galle_Biodiversity');
    const referenceTable = chooseTable(tables, 'All_Species');
    const estateBoundaryTable = chooseTable(tables, 'Estate_boun_galle');
    const districtBoundaryTable = chooseTable(tables, 'District_boundary');

    if (!observationsTable || !referenceTable) {
      return res.status(503).json({
        status: 'error',
        message: 'Galle_Biodiversity and All_Species must be available before the map can load.',
      });
    }

    const [sourceRows, referenceRows, estateRows, districtRows] = await Promise.all([
      readTable(pool, observationsTable),
      readTable(pool, referenceTable),
      estateBoundaryTable ? readTable(pool, estateBoundaryTable) : Promise.resolve([]),
      districtBoundaryTable ? readTable(pool, districtBoundaryTable) : Promise.resolve([]),
    ]);

    const { observations, matchCounts } = attachReference(sourceRows, normalizeReferenceRows(referenceRows));
    const estateFeatures = estateRows.map(makeEstateFeature).filter(Boolean);
    const districtFeatures = districtRows.map(makeDistrictFeature).filter(Boolean);
    const estateWktRows = estateRows.filter(row => String(geometryFromRow(row) ?? '').trim()).length;
    const districtWktRows = districtRows.filter(row => String(geometryFromRow(row) ?? '').trim()).length;
    const years = [...new Set(observations.map(row => row.surveyYear).filter(Number.isInteger))].sort((a, b) => a - b);
    const estates = [...new Set(observations.map(row => row.estate).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const mapWarnings = [];

    if (!estateBoundaryTable) mapWarnings.push('Estate_boun_galle was not found in the connected database.');
    else if (!estateFeatures.length) mapWarnings.push('Estate_boun_galle has no readable polygon geometry. Check its AS_WKT column.');
    if (estateFeatures.length && estateFeatures.length < estateWktRows) mapWarnings.push('Some estate geometries were skipped. Confirm AS_WKT uses WGS84 longitude/latitude coordinates.');
    if (!districtBoundaryTable) mapWarnings.push('District_boundary was not found; the district outline will be omitted.');
    else if (!districtFeatures.length) mapWarnings.push('District_boundary has no readable polygon geometry. Check its AS_WKT column.');
    if (districtFeatures.length && districtFeatures.length < districtWktRows) mapWarnings.push('Some district geometries were skipped. Confirm AS_WKT uses WGS84 longitude/latitude coordinates.');

    return res.json({
      status: 'success',
      data: {
        observations,
        estateFeatures,
        districtFeatures,
        estates,
        years,
        matchCounts,
        sourceCount: sourceRows.length,
        unmatchedEstateCodeCount: observations.filter(row => !normalizeEstateCode(row.estateCode)).length,
        tables: {
          observations: `${observationsTable.schemaName}.${observationsTable.tableName}`,
          reference: `${referenceTable.schemaName}.${referenceTable.tableName}`,
          estateBoundaries: estateBoundaryTable ? `${estateBoundaryTable.schemaName}.${estateBoundaryTable.tableName}` : null,
          districtBoundary: districtBoundaryTable ? `${districtBoundaryTable.schemaName}.${districtBoundaryTable.tableName}` : null,
        },
        mapWarnings,
      },
    });
  } catch (error) {
    console.error('Error loading Biodiversity map data:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Unable to load biodiversity map data. Check the database connection and the polygon AS_WKT fields.',
    });
  }
});

router.get('/source-data', async (req, res) => {
  try {
    const pool = await poolPromise;
    const tables = await getTables(pool);
    const observationsTable = chooseTable(tables, 'Galle_Biodiversity');
    const referenceTable = chooseTable(tables, 'All_Species');

    if (!observationsTable || !referenceTable) {
      const missing = [
        !observationsTable ? 'Galle_Biodiversity' : null,
        !referenceTable ? 'All_Species' : null,
      ].filter(Boolean);
      return res.status(503).json({
        status: 'error',
        message: 'Biodiversity source table' + (missing.length > 1 ? 's are' : ' is') + ' not available: ' + missing.join(', ') + '.',
      });
    }

    const [sourceRows, referenceRows] = await Promise.all([
      readTable(pool, observationsTable),
      readTable(pool, referenceTable),
    ]);
    const references = normalizeReferenceRows(referenceRows);
    const { observations, matchCounts } = attachReference(sourceRows, references);
    const years = [...new Set(observations.map(row => row.surveyYear).filter(Number.isInteger))].sort((a, b) => a - b);
    const estates = [...new Set(observations.map(row => row.estate).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    return res.status(200).json({
      status: 'success',
      data: {
        observations,
        sourceCount: sourceRows.length,
        referenceCount: referenceRows.length,
        usableObservationCount: observations.filter(row => row.speciesKey).length,
        missingTaxonCount: observations.filter(row => !row.speciesKey).length,
        missingSurveyYearCount: observations.filter(row => !Number.isInteger(row.surveyYear)).length,
        referenceFields: {
          hasFlagshipData: hasPopulatedField(referenceRows, 'Flagship'),
        },
        years,
        estates,
        matchCounts,
        tables: {
          observations: observationsTable.schemaName + '.' + observationsTable.tableName,
          reference: referenceTable.schemaName + '.' + referenceTable.tableName,
        },
      },
    });
  } catch (error) {
    console.error('Error loading biodiversity analysis source data:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Unable to load biodiversity tables. Check that the API can connect to SQL Server and that both source tables are available.',
    });
  }
});

module.exports = router;
