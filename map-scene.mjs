const WIDTH = 1000;
const HEIGHT = 800;
const GRID_SIZE = 32;
const STRAIGHT_COS = Math.cos(Math.PI / 12);

function boundsFor(points) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const [x, y] of points) {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function overlaps(a, b) {
  return a.x <= b.x + b.w && a.x + a.w >= b.x
    && a.y <= b.y + b.h && a.y + a.h >= b.y;
}

// Liang–Barsky clipping includes lines crossing a view with both endpoints outside.
function clipSegment(a, b, view) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let start = 0, end = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - view.x, view.x + view.w - a[0], a[1] - view.y, view.y + view.h - a[1]];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) start = Math.max(start, t);
      else end = Math.min(end, t);
      if (start > end) return null;
    }
  }
  return [start, end];
}

function intersectsLine(points, view) {
  for (let i = 1; i < points.length; i++) {
    if (clipSegment(points[i - 1], points[i], view)) return true;
  }
  return false;
}

// Fixed-size grid: bounded bucket count, no recursive index or browser state.
function spatialGrid(entries) {
  if (!entries.length) return () => [];
  const extent = boundsFor(entries.flatMap(entry => [
    [entry.bounds.x, entry.bounds.y],
    [entry.bounds.x + entry.bounds.w, entry.bounds.y + entry.bounds.h],
  ]));
  const cellWidth = Math.max(extent.w / GRID_SIZE, 1);
  const cellHeight = Math.max(extent.h / GRID_SIZE, 1);
  const cells = Array.from({ length: GRID_SIZE * GRID_SIZE }, () => []);
  const column = x => Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((x - extent.x) / cellWidth)));
  const row = y => Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((y - extent.y) / cellHeight)));
  function visit(bounds, callback) {
    const lastColumn = column(bounds.x + bounds.w), lastRow = row(bounds.y + bounds.h);
    for (let y = row(bounds.y); y <= lastRow; y++) {
      for (let x = column(bounds.x); x <= lastColumn; x++) callback(cells[y * GRID_SIZE + x]);
    }
  }
  entries.forEach((entry, index) => visit(entry.bounds, cell => cell.push(index)));
  const seen = new Uint32Array(entries.length);
  let generation = 0;
  return view => {
    if (!overlaps(extent, view)) return [];
    generation = (generation + 1) >>> 0;
    if (!generation) { seen.fill(0); generation = 1; }
    const result = [];
    visit(view, cell => {
      for (const index of cell) {
        if (seen[index] === generation) continue;
        seen[index] = generation;
        const entry = entries[index];
        if (overlaps(entry.bounds, view)) result.push(entry);
      }
    });
    return result;
  };
}

function pointKey(point) {
  return `${point[0]},${point[1]}`;
}

function distanceSquared(point, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = dx || dy ? Math.max(0, Math.min(1,
    ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
  return (point[0] - a[0] - t * dx) ** 2 + (point[1] - a[1] - t * dy) ** 2;
}

function simplify(points, tolerance, sharedVertices) {
  if (!tolerance || points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [];
  let previous = 0;
  // Shared source vertices are junctions, including another way's interior point.
  for (let i = 1; i < points.length; i++) {
    if (i === points.length - 1 || sharedVertices.has(pointKey(points[i]))) {
      keep[i] = 1;
      stack.push(previous, i);
      previous = i;
    }
  }
  const squared = tolerance * tolerance;
  while (stack.length) {
    const end = stack.pop(), start = stack.pop();
    let farthest = -1, maximum = squared;
    for (let i = start + 1; i < end; i++) {
      const distance = distanceSquared(points[i], points[start], points[end]);
      if (distance > maximum) { maximum = distance; farthest = i; }
    }
    if (farthest !== -1) {
      keep[farthest] = 1;
      stack.push(start, farthest, farthest, end);
    }
  }
  return points.filter((point, index) => keep[index]);
}

function shortStreetName(name) {
  const abbreviations = {
    Northeast: 'NE', Northwest: 'NW', Southeast: 'SE', Southwest: 'SW',
    North: 'N', South: 'S', East: 'E', West: 'W',
    Street: 'St', Avenue: 'Ave', Boulevard: 'Blvd', Drive: 'Dr',
    Road: 'Rd', Court: 'Ct', Place: 'Pl', Lane: 'Ln', Highway: 'Hwy',
  };
  return name.replace(/\b(Northeast|Northwest|Southeast|Southwest|North|South|East|West|Street|Avenue|Boulevard|Drive|Road|Court|Place|Lane|Highway)\b/g,
    word => abbreviations[word]);
}

// Each fragment is visited once. Degree != 2 terminates chains rather than
// arbitrarily attaching a label across a branch or any disconnected gap.
function connectedChains(lines, project) {
  const edges = [];
  const nodes = new Map();
  function node(key) {
    if (!nodes.has(key)) nodes.set(key, []);
    return nodes.get(key);
  }
  for (const line of lines) {
    if (line.length < 2) continue;
    const index = edges.length;
    const start = pointKey(line[0]), end = pointKey(line[line.length - 1]);
    edges.push({ points: line.map(project), start, end });
    node(start).push(index);
    node(end).push(index);
  }
  const used = new Uint8Array(edges.length);
  const chains = [];
  function walk(first, from) {
    const points = [];
    let index = first, key = from;
    while (!used[index]) {
      used[index] = 1;
      const edge = edges[index], forward = edge.start === key;
      for (let i = points.length ? 1 : 0; i < edge.points.length; i++) {
        points.push(edge.points[forward ? i : edge.points.length - 1 - i]);
      }
      key = forward ? edge.end : edge.start;
      const adjacent = nodes.get(key);
      if (adjacent.length !== 2) break;
      const next = adjacent[0] === index ? adjacent[1] : adjacent[0];
      if (used[next]) break;
      index = next;
    }
    chains.push(points);
  }
  for (const [key, adjacent] of nodes) {
    if (adjacent.length !== 2) for (const index of adjacent) if (!used[index]) walk(index, key);
  }
  for (let i = 0; i < edges.length; i++) if (!used[i]) walk(i, edges[i].start);
  return chains;
}

function lineLength(points) {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(
    points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return length;
}

export function createMapScene(data) {
  const { west, east, south, north } = data.bounds;
  const longitudeScale = Math.cos((north + south) / 2 * Math.PI / 180);
  const scale = Math.min((WIDTH - 70) / ((east - west) * longitudeScale), (HEIGHT - 70) / (north - south));
  const centerX = (west + east) / 2, centerY = (north + south) / 2;
  const project = ([lon, lat]) => [WIDTH / 2 + (lon - centerX) * longitudeScale * scale,
    HEIGHT / 2 - (lat - centerY) * scale];
  const roads = [];
  const kindOrder = new Map(data.roads.map((road, index) => [road.kind, index]));
  const vertices = new Set(), sharedVertices = new Set();
  for (const road of data.roads) for (const line of road.lines) {
    if (line.length < 2) continue;
    const points = line.map(project);
    for (const point of points) {
      const key = pointKey(point);
      if (vertices.has(key)) sharedVertices.add(key);
      else vertices.add(key);
    }
    roads.push({ kind: road.kind, points, bounds: boundsFor(points) });
  }
  const roadQuery = spatialGrid(roads);
  const bands = new Map();
  let labelQuery;
  function queryRoads(view, tolerance = 0) {
    // Round DOWN: cached simplification never exceeds the caller's error bound.
    const band = Number.isFinite(tolerance) && tolerance > 0 ? 2 ** Math.floor(Math.log2(tolerance)) : 0;
    let cache = bands.get(band);
    if (!cache) {
      cache = new Map();
      if (bands.size === 4) bands.delete(bands.keys().next().value);
    } else bands.delete(band);
    bands.set(band, cache);
    const groups = new Map();
    for (const road of roadQuery(view)) {
      if (!intersectsLine(road.points, view)) continue;
      let points = cache.get(road);
      if (!points) {
        points = simplify(road.points, band, sharedVertices);
        cache.set(road, points);
      }
      if (!groups.has(road.kind)) groups.set(road.kind, { kind: road.kind, lines: [] });
      groups.get(road.kind).lines.push(points);
    }
    return [...groups.values()].sort((a, b) => kindOrder.get(a.kind) - kindOrder.get(b.kind));
  }
  function queryLabels(view) {
    if (!labelQuery) {
      const labels = [];
      for (const street of data.labels ?? data.streets ?? []) {
        for (const points of connectedChains(street.lines, project)) {
          const length = lineLength(points);
          if (length > 0) labels.push({ id: street.id, name: shortStreetName(street.name),
            points, length, bounds: boundsFor(points) });
        }
      }
      labels.sort((a, b) => b.length - a.length);
      labels.forEach((label, order) => { label.order = order; });
      labelQuery = spatialGrid(labels);
    }
    return labelQuery(view).filter(label => intersectsLine(label.points, view))
      .sort((a, b) => a.order - b.order);
  }
  return { project, unitsPerKm: scale / 111.2,
    rivers: (data.rivers ?? []).map(line => line.map(project)), queryRoads, queryLabels };
}

function interpolate(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function visibleSpans(points, view) {
  const spans = [];
  let span = null;
  for (let i = 1; i < points.length; i++) {
    const clipped = clipSegment(points[i - 1], points[i], view);
    if (!clipped) { span = null; continue; }
    const [start, end] = clipped;
    const a = interpolate(points[i - 1], points[i], start);
    const b = interpolate(points[i - 1], points[i], end);
    if (!span || start > 0) { span = [a]; spans.push(span); }
    span.push(b);
    if (end < 1) span = null;
  }
  return spans;
}

function straightSpans(points) {
  const result = [];
  let span = [points[0]], direction = null;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0], dy = points[i][1] - points[i - 1][1];
    const length = Math.hypot(dx, dy);
    if (!length) continue;
    const next = [dx / length, dy / length];
    if (direction && next[0] * direction[0] + next[1] * direction[1] < STRAIGHT_COS) {
      result.push(span);
      span = [points[i - 1]];
      direction = null;
    }
    direction ??= next;
    span.push(points[i]);
  }
  if (span.length > 1) result.push(span);
  return result;
}

function pointAt(points, distances, distance) {
  let low = 1, high = distances.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (distances[middle] < distance) low = middle + 1;
    else high = middle;
  }
  return interpolate(points[low - 1], points[low],
    (distance - distances[low - 1]) / (distances[low] - distances[low - 1]));
}

export function labelPlacements(label, view, textWidth) {
  if (!(textWidth > 0) || !Number.isFinite(textWidth)) return [];
  const placements = [];
  for (const visible of visibleSpans(label.points, view)) {
    for (const points of straightSpans(visible)) {
      const distances = [0];
      for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + Math.hypot(
        points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
      const length = distances[distances.length - 1];
      if (length < textWidth * 1.1) continue;
      // Prefer a centered label; alternatives let the renderer avoid collisions.
      const margin = textWidth * 0.55;
      const centers = [length / 2];
      if (length > textWidth * 2) centers.push(margin, length - margin);
      for (const center of centers) {
        const start = center - textWidth / 2, end = center + textWidth / 2;
        const a = pointAt(points, distances, start), b = pointAt(points, distances, end);
        const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (chord < textWidth * 0.98) continue;
        // Do not float a straight text baseline over a bend or a hairpin.
        let straight = true;
        for (let i = 1; i < points.length - 1; i++) {
          if (distances[i] > start && distances[i] < end
            && distanceSquared(points[i], a, b) > (textWidth * 0.04) ** 2) {
            straight = false;
            break;
          }
        }
        if (!straight) continue;
        let angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
        if (angle > Math.PI / 2) angle -= Math.PI;
        if (angle < -Math.PI / 2) angle += Math.PI;
        placements.push({ x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, angle });
      }
    }
  }
  return placements;
}
