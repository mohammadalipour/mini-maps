const MAPBOX_GL_VERSION = '3.34.1';

export interface ViewerConfig {
  /** Public Mapbox token (pk.…). Without one, the page asks for it and keeps it in localStorage. */
  accessToken?: string;
  defaultTileset: string;
}

/** Map page for any tileset this API serves: /viewer?tileset=<id> */
export function viewerHtml(config: ViewerConfig): string {
  // Escape "<" so data can never close the <script> tag.
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  return PAGE.replaceAll('__GL_VERSION__', MAPBOX_GL_VERSION).replace('__CONFIG__', json);
}

// Browser code avoids template literals so this file can stay a plain TS string.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mini Maps viewer</title>
<link href="https://api.mapbox.com/mapbox-gl-js/v__GL_VERSION__/mapbox-gl.css" rel="stylesheet">
<script src="https://api.mapbox.com/mapbox-gl-js/v__GL_VERSION__/mapbox-gl.js"></script>
<style>
  body { margin: 0; font: 14px/1.4 system-ui, sans-serif; }
  #map { position: absolute; inset: 0; }
  .panel { position: absolute; top: 12px; left: 12px; background: #fff; padding: 12px 14px;
           border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.25); max-width: 300px; }
  .panel h1 { font-size: 15px; margin: 0 0 6px; }
  .panel .muted { color: #666; font-size: 12px; }
  /* :not([hidden]): author CSS would otherwise override the hidden attribute. */
  .panel form:not([hidden]) { display: flex; gap: 6px; margin-top: 8px; }
  .panel input[type=text] { flex: 1; min-width: 0; }
  .popup td { padding: 1px 6px 1px 0; vertical-align: top; }
  .popup td:first-child { color: #666; }
</style>
</head>
<body>
<div id="map"></div>
<div class="panel">
  <h1>Mini Maps</h1>
  <div id="meta">Loading…</div>
  <div id="zoom" class="muted"></div>
  <label><input type="checkbox" id="boundaries"> Show tile boundaries</label>
  <form id="token-form" hidden>
    <input type="text" id="token" placeholder="pk.…" autocomplete="off">
    <button>Use token</button>
  </form>
</div>
<script>
(function () {
  var config = __CONFIG__;
  var tileset = new URLSearchParams(location.search).get('tileset') || config.defaultTileset;
  var meta = document.getElementById('meta');
  var token = config.accessToken || localStorage.getItem('mapboxToken');

  if (!token) {
    var form = document.getElementById('token-form');
    form.hidden = false;
    meta.textContent = 'Paste a public Mapbox token (pk.…) to load the basemap.';
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      localStorage.setItem('mapboxToken', document.getElementById('token').value.trim());
      location.reload();
    });
    return;
  }

  fetch('/v1/tilesets/' + encodeURIComponent(tileset))
    .then(function (res) {
      if (!res.ok) throw new Error('Tileset "' + tileset + '" not found (HTTP ' + res.status + ')');
      return res.json();
    })
    .then(function (tilejson) { start(tilejson); })
    .catch(function (err) { meta.textContent = err.message; });

  function start(tilejson) {
    meta.textContent = tilejson.name + ' · version ' + tilejson.version.split('.')[0] +
      ' · zoom ' + tilejson.minzoom + '–' + tilejson.maxzoom;

    mapboxgl.accessToken = token;
    var map = new mapboxgl.Map({
      container: 'map',
      style: 'mapbox://styles/mapbox/standard',
      config: { basemap: { showPointOfInterestLabels: false } },
      bounds: tilejson.bounds,
      fitBoundsOptions: { padding: 60, maxZoom: 14 }
    });
    map.addControl(new mapboxgl.NavigationControl(), 'top-right');

    var zoom = document.getElementById('zoom');
    var showZoom = function () {
      var z = map.getZoom();
      zoom.textContent = 'map zoom ' + z.toFixed(1) +
        (z > tilejson.maxzoom ? ' (overzooming z' + tilejson.maxzoom + ' tiles)' : '');
    };
    map.on('zoom', showZoom);

    document.getElementById('boundaries').addEventListener('change', function (e) {
      map.showTileBoundaries = e.target.checked;
    });

    map.on('style.load', function () {
      showZoom();
      // Use the TileJSON we already fetched: same versioned tile URLs, no second request.
      map.addSource('mini', {
        type: 'vector',
        tiles: tilejson.tiles,
        minzoom: tilejson.minzoom,
        maxzoom: tilejson.maxzoom,
        bounds: tilejson.bounds
      });

      var clickable = [];
      tilejson.vector_layers.forEach(function (vl) {
        var base = { source: 'mini', 'source-layer': vl.id };
        var isType = function (types) { return ['match', ['geometry-type'], types, true, false]; };
        add(base, vl.id + '-fill', 'fill', 'middle', isType(['Polygon', 'MultiPolygon']),
          { 'fill-color': '#3bb273', 'fill-opacity': 0.35, 'fill-outline-color': '#2a7f52' });
        add(base, vl.id + '-line', 'line', 'middle', isType(['LineString', 'MultiLineString']),
          { 'line-color': '#e4572e', 'line-width': 4 });
        add(base, vl.id + '-point', 'circle', 'top', isType(['Point', 'MultiPoint']),
          { 'circle-color': '#2e86de', 'circle-radius': 6, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 });
        add(base, vl.id + '-label', 'symbol', 'top', isType(['Point', 'MultiPoint']), {
          'text-color': '#1d3557', 'text-halo-color': '#fff', 'text-halo-width': 1.5
        }, { 'text-field': ['get', 'name'], 'text-size': 12, 'text-offset': [0, 1.1], 'text-anchor': 'top' });
        clickable.push(vl.id + '-fill', vl.id + '-line', vl.id + '-point');
      });

      function add(base, id, type, slot, filter, paint, layout) {
        map.addLayer(Object.assign({ id: id, type: type, slot: slot, filter: filter, paint: paint, layout: layout || {} }, base));
      }

      map.on('click', clickable, function (e) { showProperties(e.features[0], e.lngLat); });
      clickable.forEach(function (id) {
        map.on('mouseenter', id, function () { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', id, function () { map.getCanvas().style.cursor = ''; });
      });
    });

    function showProperties(feature, lngLat) {
      // Build with DOM nodes, not HTML strings: feature properties come from uploaded data.
      var table = document.createElement('table');
      table.className = 'popup';
      Object.keys(feature.properties).forEach(function (key) {
        var row = table.insertRow();
        row.insertCell().textContent = key;
        row.insertCell().textContent = String(feature.properties[key]);
      });
      new mapboxgl.Popup().setLngLat(lngLat).setDOMContent(table).addTo(map);
    }
  }
})();
</script>
</body>
</html>
`;
