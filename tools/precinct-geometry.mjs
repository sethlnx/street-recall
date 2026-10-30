// Planar GeoJSON clipping for local longitude/latitude data (not dateline-spanning
// or spherical polygons). Valid Polygon/MultiPolygon rings are expected. Boundary
// points, including hole boundaries, belong to the area. Isolated point contacts
// are not output as roads. Coordinates within 1e-10 degrees are treated as equal
// (about 0.011 mm latitude); smaller gaps/segments are below this numeric tolerance.
const EPSILON = 1e-10;
const LEAF_SIZE = 12;

function emptyBounds() {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function expand(bounds, item) {
  bounds.minX = Math.min(bounds.minX, item.minX);
  bounds.minY = Math.min(bounds.minY, item.minY);
  bounds.maxX = Math.max(bounds.maxX, item.maxX);
  bounds.maxY = Math.max(bounds.maxY, item.maxY);
}

function overlaps(bounds, minX, minY, maxX, maxY) {
  return bounds.minX <= maxX + EPSILON && bounds.maxX >= minX - EPSILON
    && bounds.minY <= maxY + EPSILON && bounds.maxY >= minY - EPSILON;
}

// Both edge intersections and horizontal point-in-ring rays traverse the same
// bbox tree. Source coordinates are copied into edges only once, during prepare.
function buildTree(edges) {
  if (!edges.length) return null;
  const tree = emptyBounds();
  for (const edge of edges) expand(tree, edge);
  if (edges.length <= LEAF_SIZE) return { ...tree, edges };
  const axis = tree.maxX - tree.minX >= tree.maxY - tree.minY ? 'X' : 'Y';
  edges.sort((a, b) => a[`min${axis}`] + a[`max${axis}`]
    - b[`min${axis}`] - b[`max${axis}`]);
  const middle = Math.floor(edges.length / 2);
  return { ...tree, left: buildTree(edges.slice(0, middle)), right: buildTree(edges.slice(middle)) };
}

function prepareRing(coordinates) {
  const edges = [];
  for (let i = 0; i < coordinates.length; i += 1) {
    const a = coordinates[i];
    const b = coordinates[(i + 1) % coordinates.length];
    if (a[0] === b[0] && a[1] === b[1]) continue;
    edges.push({
      ax: a[0], ay: a[1], bx: b[0], by: b[1],
      minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]),
      maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]),
      length: Math.hypot(b[0] - a[0], b[1] - a[1]),
    });
  }
  return buildTree(edges);
}

/** Prepare a reusable, source-independent polygon union for clipping and lookup. */
export function prepareArea(geometry) {
  if (geometry?.type !== 'Polygon' && geometry?.type !== 'MultiPolygon') {
    throw new TypeError('Expected a GeoJSON Polygon or MultiPolygon');
  }
  const coordinates = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const polygons = [];
  const bounds = emptyBounds();
  for (const polygon of coordinates) {
    const rings = polygon.map(prepareRing);
    if (!rings[0]) continue;
    const prepared = { ...rings[0], rings };
    polygons.push(prepared);
    expand(bounds, prepared);
  }
  return { ...bounds, polygons };
}

// Returns crossing count, or -1 when the point lies on a boundary edge.
function rayCrossings(x, y, tree) {
  if (!tree || tree.maxX < x - EPSILON
    || tree.minY > y + EPSILON || tree.maxY < y - EPSILON) return 0;
  if (!tree.edges) {
    const left = rayCrossings(x, y, tree.left);
    if (left === -1) return -1;
    const right = rayCrossings(x, y, tree.right);
    return right === -1 ? -1 : left + right;
  }
  let crossings = 0;
  for (const edge of tree.edges) {
    if (edge.maxX < x - EPSILON || edge.minY > y + EPSILON || edge.maxY < y - EPSILON) continue;
    const dx = edge.bx - edge.ax;
    const dy = edge.by - edge.ay;
    if (x >= edge.minX - EPSILON && x <= edge.maxX + EPSILON
      && Math.abs((x - edge.ax) * dy - (y - edge.ay) * dx) <= EPSILON * edge.length) return -1;
    if ((edge.ay > y) !== (edge.by > y)
      && x < edge.ax + (y - edge.ay) * dx / dy) crossings += 1;
  }
  return crossings;
}

function containsXY(x, y, area) {
  if (!overlaps(area, x, y, x, y)) return false;
  for (const polygon of area.polygons) {
    if (!overlaps(polygon, x, y, x, y)) continue;
    const outer = rayCrossings(x, y, polygon.rings[0]);
    if (outer === -1) return true;
    if (outer % 2 === 0) continue;
    let inHole = false;
    for (let i = 1; i < polygon.rings.length; i += 1) {
      const hole = rayCrossings(x, y, polygon.rings[i]);
      if (hole === -1) return true;
      if (hole % 2 === 1) inHole = true;
    }
    if (!inHole) return true;
  }
  return false;
}

/** Test membership in the union; outer and hole boundaries are included. */
export function pointInArea(point, prepared) {
  return containsXY(point[0], point[1], prepared);
}

function addCut(cuts, value, tolerance) {
  cuts.push(value <= tolerance ? 0 : value >= 1 - tolerance ? 1 : value);
}

function edgeCuts(edge, ax, ay, dx, dy, parameterTolerance, cuts) {
  const ex = edge.bx - edge.ax;
  const ey = edge.by - edge.ay;
  const qx = edge.ax - ax;
  const qy = edge.ay - ay;
  const denominator = dx * ey - dy * ex;
  // Scale the parallel test to floating-point product error, not an absolute
  // determinant cutoff that would misclassify short, nonparallel road segments.
  const roundoff = 16 * Number.EPSILON * (Math.abs(dx * ey) + Math.abs(dy * ex));
  if (Math.abs(denominator) <= roundoff) {
    if (Math.abs(qx * dy - qy * dx) > EPSILON * Math.hypot(dx, dy)) return;
    const useX = Math.abs(dx) >= Math.abs(dy);
    const start = useX ? qx / dx : qy / dy;
    const end = useX ? (edge.bx - ax) / dx : (edge.by - ay) / dy;
    if (Math.max(start, end) < -parameterTolerance
      || Math.min(start, end) > 1 + parameterTolerance) return;
    addCut(cuts, start, parameterTolerance);
    addCut(cuts, end, parameterTolerance);
    return;
  }
  const t = (qx * ey - qy * ex) / denominator;
  const u = (qx * dy - qy * dx) / denominator;
  const edgeTolerance = EPSILON / edge.length;
  if (t >= -parameterTolerance && t <= 1 + parameterTolerance
    && u >= -edgeTolerance && u <= 1 + edgeTolerance) addCut(cuts, t, parameterTolerance);
}

function collectCuts(tree, minX, minY, maxX, maxY, ax, ay, dx, dy, tolerance, cuts) {
  if (!tree || !overlaps(tree, minX, minY, maxX, maxY)) return;
  if (!tree.edges) {
    collectCuts(tree.left, minX, minY, maxX, maxY, ax, ay, dx, dy, tolerance, cuts);
    collectCuts(tree.right, minX, minY, maxX, maxY, ax, ay, dx, dy, tolerance, cuts);
    return;
  }
  for (const edge of tree.edges) {
    if (overlaps(edge, minX, minY, maxX, maxY)) {
      edgeCuts(edge, ax, ay, dx, dy, tolerance, cuts);
    }
  }
}

function samePoint(a, b) {
  return Math.abs(a[0] - b[0]) <= EPSILON && Math.abs(a[1] - b[1]) <= EPSILON;
}

function appendRun(result, current, a, b, dx, dy, runStart, runEnd) {
  const start = runStart === 0 ? [a[0], a[1]] : [a[0] + runStart * dx, a[1] + runStart * dy];
  const end = runEnd === 1 ? [b[0], b[1]] : [a[0] + runEnd * dx, a[1] + runEnd * dy];
  if (current && samePoint(current[current.length - 1], start)) current.push(end);
  else {
    current = [start, end];
    result.push(current);
  }
  return current;
}

/**
 * Clip separate polylines against a polygon union without joining outside gaps.
 * Each segment is split at every boundary intersection, then open intervals are
 * classified against the union. Returned coordinates never alias source arrays.
 */
export function clipLinesToArea(lines, prepared) {
  const result = [];
  for (const line of lines) {
    let current = null;
    for (let i = 1; i < line.length; i += 1) {
      const a = line[i - 1];
      const b = line[i];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const extent = Math.max(Math.abs(dx), Math.abs(dy));
      if (extent <= EPSILON) continue;
      const minX = Math.min(a[0], b[0]);
      const minY = Math.min(a[1], b[1]);
      const maxX = Math.max(a[0], b[0]);
      const maxY = Math.max(a[1], b[1]);
      if (!overlaps(prepared, minX, minY, maxX, maxY)) {
        current = null;
        continue;
      }
      const tolerance = EPSILON / extent;
      const cuts = [0, 1];
      for (const polygon of prepared.polygons) {
        if (!overlaps(polygon, minX, minY, maxX, maxY)) continue;
        for (const ring of polygon.rings) {
          collectCuts(ring, minX, minY, maxX, maxY, a[0], a[1], dx, dy, tolerance, cuts);
        }
      }
      cuts.sort((left, right) => left - right);
      let previous = cuts[0];
      let runStart = null;
      let runEnd = null;
      // Merge adjacent retained intervals on one source segment. In particular,
      // shared/overlapping district edges must not multiply the same road part.
      for (let j = 1; j < cuts.length; j += 1) {
        const next = cuts[j];
        if (next - previous <= tolerance) continue;
        const midpoint = (previous + next) / 2;
        if (containsXY(a[0] + midpoint * dx, a[1] + midpoint * dy, prepared)) {
          if (runStart === null) runStart = previous;
          runEnd = next;
        } else {
          if (runStart !== null) {
            current = appendRun(result, current, a, b, dx, dy, runStart, runEnd);
            runStart = null;
          }
          current = null;
        }
        previous = next;
      }
      if (runStart !== null) current = appendRun(result, current, a, b, dx, dy, runStart, runEnd);
      if (runEnd === null || runEnd < 1 - tolerance) current = null;
    }
  }
  return result;
}
