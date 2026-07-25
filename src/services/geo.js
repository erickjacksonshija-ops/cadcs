// Single source of truth for reading/writing MySQL 8 SRID-4326 POINT
// columns, because the axis order is a genuine, easy-to-get-silently-wrong
// gotcha (verified empirically, not assumed from docs):
//
// For a geometry tagged SRID 4326 (WGS84), MySQL applies EPSG:4326's
// mandated (latitude, longitude) axis order to POINT()'s constructor
// arguments -- the opposite of the (x, y) = (lng, lat) order most
// GIS/GeoJSON tooling uses. So the point must always be built as
// POINT(lat, lng); ST_X() then correctly returns longitude and ST_Y()
// returns latitude. Getting this backwards silently swaps every
// coordinate written to the database.
//
// Use POINT_SQL in any INSERT/UPDATE that writes a location, with named
// params :lat/:lng. Use LAT_LNG_COLUMNS(expr) in any SELECT that reads one.

const POINT_SQL = 'ST_SRID(POINT(:lat, :lng), 4326)';

function latLngColumns(columnExpr, { latAlias = 'lat', lngAlias = 'lng' } = {}) {
  return `ST_Y(${columnExpr}) AS ${latAlias}, ST_X(${columnExpr}) AS ${lngAlias}`;
}

module.exports = { POINT_SQL, latLngColumns };
