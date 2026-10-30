#!/usr/bin/env node
// Refresh with: node tools/update-portland.mjs
// OSM © OpenStreetMap contributors (ODbL 1.0); boundaries © Portland Police Bureau.
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { classifyPortlandStreet } from './portland-study-policy.mjs';
import { connectPendletonStreets } from './pendleton-study-policy.mjs';
import { mergeVariantStreets } from './street-variants.mjs';
import { IMPORTANCE_POLICY, rankStreetsByImportance } from './street-rank.mjs';

const { values } = parseArgs({ options: {
  endpoint: { type: 'string', default: 'https://overpass-api.de/api/interpreter' },
  'cache-dir': { type: 'string' },
} });
const destination = new URL('../data/portland.json', import.meta.url);
const boundaryLayer = 'https://www.portlandmaps.com/arcgis/rest/services/Public/CGIS_Layers/MapServer/18';
const boundaryEndpoint = `${boundaryLayer}/query?f=geojson&where=1%3D1&outFields=PRECINCT%2CDISTRICT&outSR=4326&returnGeometry=true`;
const labelHighways = new Set([
  'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street',
]);
const majorHighways = new Set(['primary', 'secondary', 'tertiary']);
const contextHighways = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential',
  'unclassified', 'living_street',
]);
const minimumPartMeters = 90;
const precincts = [
  { code: 'CE', id: 'central', name: 'Central Precinct' },
  { code: 'NO', id: 'north', name: 'North Precinct' },
  { code: 'EA', id: 'east', name: 'East Precinct' },
];

function geometryBounds(geometry) {
  const bounds = { south: Infinity, north: -Infinity, west: Infinity, east: -Infinity };
  for (const polygon of geometry.coordinates) {
    for (const ring of polygon) {
      for (const [lon, lat] of ring) {
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error('Invalid boundary coordinate');
        bounds.south = Math.min(bounds.south, lat);
        bounds.north = Math.max(bounds.north, lat);
        bounds.west = Math.min(bounds.west, lon);
        bounds.east = Math.max(bounds.east, lon);
      }
    }
  }
  if (!Object.values(bounds).every(Number.isFinite)) throw new Error('Empty precinct geometry');
  return bounds;
}

function lengthMeters(lines) {
  const radians = Math.PI / 180;
  let meters = 0;
  for (const line of lines) {
    for (let i = 1; i < line.length; i += 1) {
      const [lon1, lat1] = line[i - 1];
      const [lon2, lat2] = line[i];
      const h = Math.sin((lat2 - lat1) * radians / 2) ** 2
        + Math.cos(lat1 * radians) * Math.cos(lat2 * radians)
        * Math.sin((lon2 - lon1) * radians / 2) ** 2;
      meters += 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
    }
  }
  return meters;
}

async function cachedSource(cacheDirectory, name, endpoint, query) {
  const path = join(cacheDirectory, `${name}.json`);
  try {
    const cached = JSON.parse(await readFile(path, 'utf8'));
    if (cached.endpoint !== endpoint || cached.query !== query || !cached.fetchedAt || !cached.payload) {
      throw new Error(`Source cache does not match this request: ${path}`);
    }
    return cached;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  console.error(`Fetching ${name} from ${endpoint}`);
  const response = await fetch(endpoint, {
    ...(query ? { method: 'POST', body: new URLSearchParams({ data: query }) } : {}),
    headers: {
      Accept: 'application/json',
      'User-Agent': 'PortlandStreetRecall/1.0 (OpenStreetMap study map refresh)',
    },
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) throw new Error(`${name} returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const payload = await response.json();
  if (payload.error || payload.remark) {
    throw new Error(`${name} did not complete: ${JSON.stringify(payload.error ?? payload.remark)}`);
  }
  const source = { endpoint, query, fetchedAt: new Date().toISOString(), payload };
  await writeFile(path, JSON.stringify(source), 'utf8');
  return source;
}

async function main() {
  const cacheDirectory = values['cache-dir']
    ? resolve(values['cache-dir']) : await mkdtemp(join(tmpdir(), 'portland-map-sources-'));
  await mkdir(cacheDirectory, { recursive: true });
  const pendingDestination = new URL('../data/portland.json.pending', import.meta.url);
  try {
    const official = await cachedSource(cacheDirectory, 'districts', boundaryEndpoint, null);
    const features = official.payload.features;
    if (official.payload.type !== 'FeatureCollection' || !Array.isArray(features) || !features.length
        || official.payload.exceededTransferLimit) {
      throw new Error('Official boundary source is empty or incomplete');
    }
    const byCode = new Map(precincts.map(precinct => [precinct.code, []]));
    for (const feature of features) {
      const code = feature.properties?.PRECINCT;
      if (!byCode.has(code)) throw new Error(`Unexpected official precinct code: ${code}`);
      const geometry = feature.geometry;
      if (geometry?.type === 'Polygon') byCode.get(code).push(geometry.coordinates);
      else if (geometry?.type === 'MultiPolygon') byCode.get(code).push(...geometry.coordinates);
      else throw new Error(`Unsupported official district geometry: ${geometry?.type}`);
    }
    const areas = precincts.map(({ code, id, name }) => {
      const geometry = { type: 'MultiPolygon', coordinates: byCode.get(code) };
      return {
        id, name,
        description: `Official Portland Police Bureau ${name}; union of the City's police district polygons (${code}).`,
        bounds: geometryBounds(geometry), geometry,
      };
    });
    const unionGeometry = { type: 'MultiPolygon', coordinates: areas.flatMap(area => area.geometry.coordinates) };
    const bounds = geometryBounds(unionGeometry);
    const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
    const query = `[out:json][timeout:60];(way["highway"~"^(${[...contextHighways].join('|')})$"](${bbox});way["waterway"="river"](${bbox}););out geom;`;
    const osm = await cachedSource(cacheDirectory, 'osm', values.endpoint, query);
    const raw = osm.payload;
    if (!Array.isArray(raw.elements) || !raw.elements.length || !raw.osm3s?.timestamp_osm_base) {
      throw new Error('Overpass response is missing ways or the OSM snapshot timestamp');
    }
    const { prepareArea, clipLinesToArea } = await import('./precinct-geometry.mjs');
    const prepared = new Map(areas.map(area => [area.id, prepareArea(area.geometry)]));
    const union = prepareArea(unionGeometry);
    const roadsByKind = new Map();
    const rivers = [];
    let streetsByName = new Map();
    let majorMetersByName = new Map();
    let highwayWayCount = 0;
    let riverWayCount = 0;
    for (const way of raw.elements) {
      if (way.type !== 'way' || !Array.isArray(way.geometry) || way.geometry.length < 2) continue;
      const line = way.geometry.map(point => [point.lon, point.lat]);
      if (!line.every(point => point.every(Number.isFinite))) throw new Error(`Invalid OSM way geometry: ${way.id}`);
      const tags = way.tags ?? {};
      const lines = clipLinesToArea([line], union);
      if (!lines.length) continue;
      if (contextHighways.has(tags.highway)) {
        highwayWayCount += 1;
        if (!roadsByKind.has(tags.highway)) roadsByKind.set(tags.highway, []);
        roadsByKind.get(tags.highway).push(...lines);
      }
      if (tags.waterway === 'river') {
        riverWayCount += 1;
        rivers.push(...lines);
      }
      if (!tags.name || !labelHighways.has(tags.highway)) continue;
      const name = tags.name;
      if (majorHighways.has(tags.highway)) {
        if (!majorMetersByName.has(name)) majorMetersByName.set(name, {});
        const meters = majorMetersByName.get(name);
        meters[tags.highway] = (meters[tags.highway] ?? 0) + lengthMeters(lines);
      }
      if (!streetsByName.has(name)) streetsByName.set(name, new Map());
      const parts = streetsByName.get(name);
      for (const area of areas) {
        const clipped = clipLinesToArea([line], prepared.get(area.id));
        if (!clipped.length) continue;
        if (!parts.has(area.id)) parts.set(area.id, []);
        parts.get(area.id).push(...clipped);
      }
    }
    const variants = mergeVariantStreets(streetsByName, majorMetersByName);
    ({ streetsByName, metersByName: majorMetersByName } = variants);
    const labelStreets = [];
    for (const [name, candidates] of streetsByName) {
      const parts = {};
      for (const area of areas) {
        const lines = candidates.get(area.id);
        if (lines && lengthMeters(lines) >= minimumPartMeters) parts[area.id] = lines;
      }
      if (Object.keys(parts).length) labelStreets.push({ id: name, name, lines: Object.values(parts).flat(), parts });
    }
    labelStreets.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const labels = labelStreets.map(({ id, name, lines }) => ({ id, name, lines }));
    const eligibleStreets = [];
    for (const street of labelStreets) {
      const classification = classifyPortlandStreet(street.name, majorMetersByName.get(street.name) ?? {});
      if (classification) eligibleStreets.push({ ...street, ...classification });
    }
    // Reconnect cards split across unnamed links, concurrencies and short
    // intersection gaps; precinct polygons clip in place of Pendleton's rectangles.
    const roads = [...roadsByKind].sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([kind, lines]) => ({ kind, lines }));
    const streets = rankStreetsByImportance(connectPendletonStreets(eligibleStreets, roads,
      areas.map(area => ({ id: area.id, bounds: prepared.get(area.id) })),
      (line, area) => clipLinesToArea([line], area)));
    const streetsPerArea = Object.fromEntries(areas.map(area => [area.id,
      streets.filter(street => street.parts[area.id]?.length).length]));
    if (!streets.length || Object.values(streetsPerArea).some(count => !count)) {
      throw new Error('No eligible study streets in one or more precincts; refusing to replace dataset');
    }
    const data = {
      title: 'Portland, Oregon', bounds,
      source: 'https://www.openstreetmap.org/copyright', snapshot: raw.osm3s.timestamp_osm_base,
      provenance: {
        attribution: '© OpenStreetMap contributors', license: 'ODbL 1.0',
        licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
        endpoint: osm.endpoint, query: osm.query, fetchedAt: osm.fetchedAt, generator: raw.generator,
        refreshCommand: 'node tools/update-portland.mjs', minimumPartMeters,
        eligibleHighways: [...majorHighways], labelHighways: [...labelHighways], contextHighways: [...contextHighways],
        studyPolicy: {
          ...IMPORTANCE_POLICY,
          minimumMajorClassMeters: 90,
          eligibility: 'Primary and secondary arterials, and named tertiary collectors, with at least 90 mapped meters of that class inside Portland. Residential/local roads and numbered tertiary collectors are map context only.',
          mapLabelStreetCount: labels.length,
          classification: 'Highest OSM road class with at least 90 mapped meters inside Portland. Retained street names keep their full precinct-clipped geometry.',
        },
        geometry: 'OSM ways clipped to the exact union of official district polygons per precinct, preserving holes and disconnected segments. Source vertices and clipped intersections retain full coordinate precision. No bounding-box street assignment, coordinate rounding or line simplification. Lengths measured on a sphere of mean Earth radius 6371008.8 m.',
        boundaries: {
          attribution: 'Portland Police Bureau', source: boundaryLayer,
          overview: 'https://www.portland.gov/police/divisions/precincts',
          endpoint: official.endpoint, fetchedAt: official.fetchedAt,
          districtCount: features.length,
          districtsPerPrecinct: Object.fromEntries(precincts.map(precinct => [precinct.id,
            features.filter(feature => feature.properties.PRECINCT === precinct.code).length])),
          geometry: 'Unmodified WGS84 official district polygons grouped by PRECINCT (CE, NO, EA) into MultiPolygons; union membership, not dissolved boundaries.',
          limitation: 'The official layer describes police districts only within the City of Portland; boundaries are the retrieval snapshot and can change. District polygons are retained individually within each precinct.',
        },
        limitations: 'OSM coverage and names are community maintained. Only the listed road classes are included; service roads, parking aisles, footways and other path classes are intentionally excluded. Rivers are mapped river centerlines, not water-surface polygons. The Overpass snapshot timestamp dates OSM data; the official boundary source does not expose a matching historical snapshot.',
        highwayWayCount, riverWayCount,
      },
      areas,
      roads: [...roadsByKind].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([kind, lines]) => ({ kind, lines })),
      rivers, labels, streets,
    };
    const json = `${JSON.stringify(data)}\n`;
    await mkdir(new URL('../data/', import.meta.url), { recursive: true });
    await writeFile(pendingDestination, json, 'utf8');
    await rename(pendingDestination, destination);
    await rm(join(cacheDirectory, 'districts.json'));
    await rm(join(cacheDirectory, 'osm.json'));
    await rmdir(cacheDirectory).catch(error => { if (error.code !== 'ENOTEMPTY') throw error; });
    console.log(JSON.stringify({
      path: fileURLToPath(destination), snapshot: data.snapshot,
      fetchedAt: osm.fetchedAt, boundaryFetchedAt: official.fetchedAt,
      bytes: Buffer.byteLength(json), totalUniqueStreets: streets.length, streetsPerArea,
      mapLabelStreets: labels.length, variantMerges: variants.merges,
      roadClassCounts: Object.fromEntries(['primary', 'secondary', 'tertiary'].map(roadClass => [roadClass, streets.filter(street => street.roadClass === roadClass).length])),
      mostImportant: streets.slice(0, 5).map(street => street.name),
      districtCount: features.length, highwayWayCount, riverWayCount,
      osmEndpoint: osm.endpoint, boundaryEndpoint: official.endpoint,
    }, null, 2));
  } catch (error) {
    await rm(pendingDestination, { force: true });
    console.error(`Sources retained at ${cacheDirectory}; resume with --cache-dir ${JSON.stringify(cacheDirectory)}`);
    throw error;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
