#!/usr/bin/env node
// Refresh with: node tools/update-map.mjs
// OpenStreetMap data is © OpenStreetMap contributors, licensed under ODbL 1.0.
// These rectangular study areas are descriptive, not official neighborhoods.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { classifyPendletonStreet, connectPendletonStreets } from './pendleton-study-policy.mjs';
import { mergeVariantStreets } from './street-variants.mjs';

const destination = new URL('../data/pendleton.json', import.meta.url);
const endpoint = 'https://overpass-api.de/api/interpreter';
const bounds = { south: 45.639, north: 45.712, west: -118.882, east: -118.7495 };
const areas = [
  {
    id: 'downtown', name: 'Downtown',
    description: 'Central streets around Main and Court.',
    bounds: { south: 45.669, north: 45.676, west: -118.792, east: -118.779 },
  },
  {
    id: 'north', name: 'North Pendleton',
    description: 'North of downtown toward North Hill.',
    bounds: { south: 45.676, north: 45.712, west: -118.805, east: -118.779 },
  },
  {
    id: 'west', name: 'West & airport',
    description: 'Western streets and the airport area.',
    bounds: { south: 45.639, north: 45.712, west: -118.882, east: -118.805 },
  },
  {
    id: 'southwest', name: 'Southwest Pendleton',
    description: 'West of downtown, south toward I-84.',
    bounds: { south: 45.639, north: 45.676, west: -118.805, east: -118.792 },
  },
  {
    id: 'south', name: 'South Pendleton',
    description: 'South of downtown toward Southgate.',
    bounds: { south: 45.639, north: 45.669, west: -118.792, east: -118.779 },
  },
  {
    id: 'east', name: 'East Pendleton',
    description: 'Eastern streets toward Riverside.',
    bounds: { south: 45.639, north: 45.712, west: -118.779, east: -118.7495 },
  },
];
const eligibleHighways = new Set([
  'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street',
]);
const minimumPartMeters = 90;
const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
const query = `[out:json][timeout:90];(way["highway"](${bbox});way["waterway"="river"](${bbox}););out geom;`;

// Liang–Barsky clips each original segment, rather than joining inside vertices
// across an outside excursion. Separate ways also remain separate polylines.
function clipSegment(a, b, rectangle) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - rectangle.west, rectangle.east - a[0],
    a[1] - rectangle.south, rectangle.north - a[1]];
  let start = 0;
  let end = 1;
  for (let i = 0; i < 4; i += 1) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
      continue;
    }
    const fraction = q[i] / p[i];
    if (p[i] < 0) start = Math.max(start, fraction);
    else end = Math.min(end, fraction);
    if (start >= end) return null;
  }
  const point = t => [
    Math.max(rectangle.west, Math.min(rectangle.east, a[0] + t * dx)),
    Math.max(rectangle.south, Math.min(rectangle.north, a[1] + t * dy)),
  ];
  return [point(start), point(end)];
}

function samePoint(a, b) {
  return Math.abs(a[0] - b[0]) < 1e-10 && Math.abs(a[1] - b[1]) < 1e-10;
}

function clipLine(points, rectangle) {
  const lines = [];
  let current = null;
  for (let i = 1; i < points.length; i += 1) {
    const segment = clipSegment(points[i - 1], points[i], rectangle);
    if (!segment || samePoint(segment[0], segment[1])) {
      current = null;
      continue;
    }
    if (current && samePoint(current[current.length - 1], segment[0])) {
      current.push(segment[1]);
    } else {
      current = segment;
      lines.push(current);
    }
  }
  return lines;
}

function lengthMeters(lines) {
  const radians = Math.PI / 180;
  let meters = 0;
  for (const line of lines) {
    for (let i = 1; i < line.length; i += 1) {
      const [lon1, lat1] = line[i - 1];
      const [lon2, lat2] = line[i];
      const dLat = (lat2 - lat1) * radians;
      const dLon = (lon2 - lon1) * radians;
      const h = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(dLon / 2) ** 2;
      meters += 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
    }
  }
  return meters;
}

async function main() {
  let previousDowntownIds = [];
  try {
    const previous = JSON.parse(await readFile(destination, 'utf8'));
    previousDowntownIds = previous.streets
      .filter(street => !previous.areas || street.parts?.downtown?.length)
      .map(street => street.id);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    body: new URLSearchParams({ data: query }),
    headers: {
      Accept: 'application/json',
      'User-Agent': 'PendletonStreetRecall/1.0 (OpenStreetMap study map refresh)',
    },
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    throw new Error(`Overpass returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  const raw = await response.json();
  // Overpass can return HTTP 200 with a timeout remark and partial results.
  if (raw.remark) throw new Error(`Overpass did not complete: ${raw.remark}`);
  if (!Array.isArray(raw.elements) || !raw.osm3s?.timestamp_osm_base) {
    throw new Error('Overpass response is missing elements or the OSM snapshot timestamp');
  }

  const roadsByKind = new Map();
  const rivers = [];
  let streetsByName = new Map();
  let metersByName = new Map();
  const fetchedNames = new Set();
  for (const way of raw.elements) {
    if (way.type !== 'way' || !Array.isArray(way.geometry)) continue;
    const points = way.geometry.map(point => [point.lon, point.lat]);
    const lines = clipLine(points, bounds);
    if (!lines.length) continue;
    const tags = way.tags ?? {};
    if (tags.highway) {
      if (!roadsByKind.has(tags.highway)) roadsByKind.set(tags.highway, []);
      roadsByKind.get(tags.highway).push(...lines);
    }
    if (tags.waterway === 'river') rivers.push(...lines);
    if (!tags.name || !eligibleHighways.has(tags.highway)) continue;
    const name = tags.name;
    fetchedNames.add(name);
    if (!metersByName.has(name)) metersByName.set(name, {});
    const meters = metersByName.get(name);
    meters[tags.highway] = (meters[tags.highway] ?? 0) + lengthMeters(lines);
    if (!streetsByName.has(name)) streetsByName.set(name, new Map());
    const parts = streetsByName.get(name);
    for (const area of areas) {
      const clipped = clipLine(points, area.bounds);
      if (!clipped.length) continue;
      if (!parts.has(area.id)) parts.set(area.id, []);
      parts.get(area.id).push(...clipped);
    }
  }
  const variants = mergeVariantStreets(streetsByName, metersByName);
  ({ streetsByName, metersByName } = variants);

  const rawStreets = [];
  for (const [name, candidates] of streetsByName) {
    const parts = {};
    for (const area of areas) {
      const lines = candidates.get(area.id);
      if (lines && lengthMeters(lines) >= minimumPartMeters) parts[area.id] = lines;
    }
    const areaIds = Object.keys(parts);
    const classification = classifyPendletonStreet(name, metersByName.get(name) ?? {}, areaIds);
    if (classification) {
      rawStreets.push({ id: name, name, lines: Object.values(parts).flat(), parts, ...classification });
    }
  }
  rawStreets.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const roads = [...roadsByKind].sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([kind, lines]) => ({ kind, lines }));
  const streets = connectPendletonStreets(rawStreets, roads, areas, clipLine);
  if (!streets.length) throw new Error('Overpass returned no eligible study streets; refusing to replace dataset');
  const data = {
    title: 'Pendleton, Oregon',
    bounds,
    source: 'https://www.openstreetmap.org/copyright',
    snapshot: raw.osm3s.timestamp_osm_base,
    provenance: {
      attribution: '© OpenStreetMap contributors',
      license: 'ODbL 1.0',
      licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
      endpoint,
      query,
      fetchedAt: new Date().toISOString(),
      generator: raw.generator,
      refreshCommand: 'node tools/update-map.mjs',
      minimumPartMeters,
      eligibleHighways: [...eligibleHighways],
      studyPolicy: {
        description: 'Major throughways (primary, secondary, tertiary) first, ordered by area importance (Downtown, central Pendleton neighborhoods, West & airport), followed by Downtown and neighborhood multi-area throughways and local streets, with outlying rural and airport unclassified roads last.',
        minimumMajorClassMeters: 90,
        areaTiers: ['downtown', 'south/southwest/north/east', 'west'],
        introductionOrder: [
          'primary throughways (Downtown, central, West & airport)',
          'secondary throughways (Downtown, central, West & airport)',
          'tertiary collectors (Downtown, central, West & airport)',
          'Downtown multi-area throughways and local streets',
          'central neighborhood multi-area throughways and local streets',
          'West & airport residential streets',
          'outlying and airport unclassified roads',
        ],
      },
      geometry: 'OSM way geometry clipped to study bounds and descriptive study rectangles, with continuous street polylines reconnected across sub-90m area corners, colinear unnamed road segments, shared highway concurrencies, and short cross-street doglegs; lengths measured on a sphere with mean Earth radius 6371008.8 m.',
    },
    areas,
    roads,
    rivers,
    streets,
  };
  const json = `${JSON.stringify(data)}\n`;
  await mkdir(new URL('../data/', import.meta.url), { recursive: true });
  await writeFile(destination, json, 'utf8');
  const downtownIds = new Set(streets.filter(street => street.parts.downtown).map(street => street.id));
  console.log(JSON.stringify({
    path: fileURLToPath(destination),
    snapshot: data.snapshot,
    fetchedAt: data.provenance.fetchedAt,
    bytes: Buffer.byteLength(json),
    totalUniqueStreets: streets.length,
    streetsPerArea: Object.fromEntries(areas.map(area => [area.id,
      streets.filter(street => street.parts[area.id]).length])),
    introductionTiers: Object.fromEntries(
      [...new Set(streets.map(street => street.priority))].sort((a, b) => a - b)
        .map(priority => [priority, streets.filter(street => street.priority === priority).length]),
    ),
    variantMerges: variants.merges,
    previousDowntownCount: previousDowntownIds.length,
    oldDowntownIdsMissing: previousDowntownIds.filter(id => !downtownIds.has(id)),
    oldDowntownIdsAbsentFromFetchedEligibleWays: previousDowntownIds.filter(id => !fetchedNames.has(id)),
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
