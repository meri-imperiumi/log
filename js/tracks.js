// Track rendering helpers for the MapLibre map views.
//
// Keeps a vessel track continuous across the antimeridian: raw GPS
// longitudes jump between +179.x and -179.x on the crossing, which
// MapLibre draws as a line wrapping around the globe. Shifting the
// longitudes beyond ±180° instead lets the map place the line on the
// adjacent world copy, so it stays continuous.
function unwrapLongitudes(coordinates) {
  let offset = 0;
  let previous = null;
  return coordinates.map((coord) => {
    let lon = coord[0] + offset;
    if (previous !== null && Math.abs(lon - previous) > 180) {
      offset -= Math.sign(lon - previous) * 360;
      lon = coord[0] + offset;
    }
    previous = lon;
    return [lon, coord[1]];
  });
}
