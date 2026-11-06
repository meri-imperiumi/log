// Track rendering helpers for the MapLibre map views.
//
// Keeps a vessel track continuous across the antimeridian: raw GPS
// longitudes jump between +179.x and -179.x on the crossing, which
// MapLibre draws as a line wrapping around the globe. Shifting the
// longitudes beyond ±180° instead lets the map place the line on the
// adjacent world copy, so it stays continuous.
// Computes the map center that places the vessel at a given screen
// position, expressed as pixel offset from the map's center point. At
// zoom z the whole world is 512*2^z pixels wide. The mercator latitude
// helper here grows northwards, so a pixel delta pointing down the
// screen (positive dY) moves the center north. Purely absolute: the
// result depends only on the vessel position, zoom and pixel delta, so
// it stays correct when re-applied after resizes.
function boatCenter(position, zoom, pixelDelta) {
  const worldSize = 512 * Math.pow(2, zoom);
  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));
  const unmercY = (m) => (2 * Math.atan(Math.exp(m)) - Math.PI / 2) * 180 / Math.PI;
  return [
    position[0] - pixelDelta[0] * 360 / worldSize,
    unmercY(mercY(position[1]) + pixelDelta[1] * 2 * Math.PI / worldSize),
  ];
}

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
