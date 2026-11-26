function readRingCoordinates(ringText) {
  return ringText.split(',').map(pair => {
    const values = pair.trim().split(/\s+/).map(Number);
    return Number.isFinite(values[0]) && Number.isFinite(values[1])
      ? [values[0], values[1]]
      : null;
  }).filter(Boolean);
}

function visitCoordinates(value, callback) {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
    callback(value);
    return;
  }
  value.forEach(item => visitCoordinates(item, callback));
}

function isGeographicGeometry(geometry) {
  let foundCoordinate = false;
  let withinWgs84Range = true;
  visitCoordinates(geometry?.coordinates, coordinate => {
    foundCoordinate = true;
    if (coordinate[0] < -180 || coordinate[0] > 180 || coordinate[1] < -90 || coordinate[1] > 90) {
      withinWgs84Range = false;
    }
  });
  return foundCoordinate && withinWgs84Range;
}

function normalizeSriLankaAxisOrder(geometry) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  visitCoordinates(geometry.coordinates, ([x, y]) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  });

  // Sri Lanka's bounds make an accidentally latitude-first WKT axis order recognizable.
  const appearsLatFirst = minX >= 4 && maxX <= 12 && minY >= 75 && maxY <= 84;
  if (!appearsLatFirst) return geometry;

  const swapPairs = value => {
    if (!Array.isArray(value)) return value;
    if (value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
      return [value[1], value[0], ...value.slice(2)];
    }
    return value.map(swapPairs);
  };

  return { ...geometry, coordinates: swapPairs(geometry.coordinates) };
}

function wktToGeoJson(value) {
  if (typeof value !== 'string') return null;

  const wkt = value.trim().replace(/^SRID=\d+\s*;/i, '');
  const typeMatch = wkt.match(/^(MULTIPOLYGON|POLYGON)\s*(?:ZM|Z|M)?\s*\(/i);
  if (!typeMatch) return null;

  const type = typeMatch[1].toUpperCase();
  const ringDepth = type === 'POLYGON' ? 2 : 3;
  const polygons = [];
  let depth = 0;
  let currentPolygon = -1;
  let ringStart = -1;

  for (let index = wkt.indexOf('('); index < wkt.length; index += 1) {
    if (wkt[index] === '(') {
      depth += 1;
      if (type === 'MULTIPOLYGON' && depth === 2) {
        currentPolygon += 1;
        polygons[currentPolygon] = [];
      }
      if (depth === ringDepth) ringStart = index + 1;
      continue;
    }

    if (wkt[index] !== ')') continue;
    if (depth === ringDepth && ringStart >= 0) {
      const ring = readRingCoordinates(wkt.slice(ringStart, index));
      if (ring.length >= 4) {
        const polygonIndex = type === 'POLYGON' ? 0 : currentPolygon;
        if (!polygons[polygonIndex]) polygons[polygonIndex] = [];
        polygons[polygonIndex].push(ring);
      }
      ringStart = -1;
    }
    depth -= 1;
  }

  const coordinates = polygons.filter(polygon => polygon.length > 0);
  if (!coordinates.length) return null;

  const geometry = type === 'POLYGON'
    ? { type: 'Polygon', coordinates: coordinates[0] }
    : { type: 'MultiPolygon', coordinates };
  return normalizeSriLankaAxisOrder(geometry);
}

module.exports = { isGeographicGeometry, wktToGeoJson };
