import test from 'node:test';
import assert from 'node:assert/strict';
import { createMapScene, labelPlacements } from './map-scene.mjs';

const whole = { x: 0, y: 0, w: 1000, h: 800 };
// Symmetric bounds make the existing 1000x800 projection scale exactly 365.
const geographic = ([x, y]) => [(x - 500) / 365, (400 - y) / 365];
const sourceLine = points => points.map(geographic);
const road = (kind, ...lines) => ({ kind, lines: lines.map(sourceLine) });
const street = (name, ...lines) => ({ id: name, name, lines: lines.map(sourceLine) });
function fixture(roads = [], streets = []) {
  return { bounds: { west: -1, east: 1, south: -1, north: 1 }, roads, rivers: [], streets };
}
function near(actual, expected, epsilon = 1e-8) {
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} should equal ${expected}`);
}
function freezeDeep(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}
function pointDistance(point, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = dx || dy ? Math.max(0, Math.min(1,
    ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
}
function nearestSegment(point, points) {
  let distance = Infinity;
  for (let i = 1; i < points.length; i++) distance = Math.min(distance,
    pointDistance(point, points[i - 1], points[i]));
  return distance;
}

test('projection keeps the existing padding, latitude orientation, and kilometer scale', () => {
  const data = fixture();
  data.rivers = [sourceLine([[300, 200], [600, 450]])];
  const scene = createMapScene(data);
  assert.deepEqual(scene.project([0, 0]), [500, 400]);
  assert.deepEqual(scene.project([-1, 1]), [135, 35]);
  assert.deepEqual(scene.project([1, -1]), [865, 765]);
  near(scene.unitsPerKm, 365 / 111.2);
  near(scene.rivers[0][0][0], 300);
  near(scene.rivers[0][1][1], 450);
});

test('crossing roads survive the spatial query and unrelated distant roads do not', () => {
  const data = fixture([
    road('residential', [[100, 400], [900, 400]]),
    road('residential', [[800, 700], [900, 700]]),
    road('service', [[490, 100], [490, 700]]),
  ]);
  const scene = createMapScene(data);
  const groups = scene.queryRoads({ x: 480, y: 380, w: 40, h: 40 });
  assert.deepEqual(groups.map(group => group.kind).sort(), ['residential', 'service']);
  assert.equal(groups.find(group => group.kind === 'residential').lines.length, 1);
  assert.deepEqual(scene.queryRoads({ x: 1100, y: 900, w: 10, h: 10 }), []);
});

test('a bounding box around an empty road bend does not count as visible geometry', () => {
  const scene = createMapScene(fixture([
    road('service', [[100, 100], [100, 700], [900, 700], [900, 100]]),
  ]));
  assert.deepEqual(scene.queryRoads({ x: 400, y: 300, w: 100, h: 100 }), []);
});

test('simplification preserves endpoints, a real bend, and the requested error bound', () => {
  const points = [];
  for (let x = 100; x <= 900; x += 10) points.push([x, 400 + Math.sin(x) * 0.5]);
  points[40] = [500, 445];
  const data = fixture([road('residential', points)]);
  const scene = createMapScene(data);
  const simplified = scene.queryRoads(whole, 3.9)[0].lines[0];
  assert.ok(simplified.length < points.length / 2);
  assert.deepEqual(simplified[0], scene.project(data.roads[0].lines[0][0]));
  assert.deepEqual(simplified.at(-1), scene.project(data.roads[0].lines[0].at(-1)));
  assert.ok(simplified.some(point => Math.abs(point[1] - 445) < 1e-8));
  for (const point of data.roads[0].lines[0].map(scene.project)) {
    assert.ok(nearestSegment(point, simplified) <= 3.9 + 1e-8);
  }
});

test('shared junctions are retained even when simplification could erase them', () => {
  const scene = createMapScene(fixture([
    road('residential', [[100, 400], [500, 401], [900, 400]]),
    road('service', [[500, 401], [500, 600]]),
  ]));
  const main = scene.queryRoads(whole, 8).find(group => group.kind === 'residential').lines[0];
  assert.equal(main.length, 3);
  near(main[1][0], 500);
  near(main[1][1], 401);
});

test('a zoom band reuses geometry, rounds error down, and keeps exact geometry at zero', () => {
  const scene = createMapScene(fixture([
    road('residential', [[100, 400], [500, 401.5], [900, 400]]),
  ]));
  const loose = scene.queryRoads(whole, 3.9)[0].lines[0];
  assert.equal(loose.length, 2);
  assert.equal(scene.queryRoads(whole, 2.1)[0].lines[0], loose);
  const conservative = scene.queryRoads(whole, 1.9)[0].lines[0];
  assert.equal(conservative.length, 3);
  assert.equal(scene.queryRoads(whole, 0)[0].lines[0].length, 3);
});

test('label geometry is lazy and reads the label source only once', () => {
  const data = fixture();
  let reads = 0;
  Object.defineProperty(data, 'labels', { get() {
    reads++;
    return [street('Northeast Main Street', [[100, 400], [900, 400]])];
  } });
  const scene = createMapScene(data);
  scene.queryRoads(whole, 1);
  assert.equal(reads, 0);
  assert.equal(scene.queryLabels(whole)[0].name, 'NE Main St');
  scene.queryLabels(whole);
  assert.equal(reads, 1);
});

test('Portland labels override the study deck while Pendleton falls back to streets', () => {
  const data = fixture([], [street('West Court Avenue', [[100, 200], [900, 200]])]);
  const pendleton = createMapScene(data).queryLabels(whole);
  assert.equal(pendleton[0].id, 'West Court Avenue');
  assert.equal(pendleton[0].name, 'W Ct Ave');
  data.labels = [street('Northwest Coast Highway', [[100, 400], [900, 400]])];
  assert.deepEqual(createMapScene(data).queryLabels(whole).map(label => label.id), ['Northwest Coast Highway']);
  assert.equal(createMapScene(data).queryLabels(whole)[0].name, 'NW Coast Hwy');
  data.labels = [];
  assert.deepEqual(createMapScene(data).queryLabels(whole), []);
});

test('reversed touching fragments become one connected chain without source mutation', () => {
  const data = freezeDeep(fixture([], [street('Main Street',
    [[100, 400], [300, 400]], [[500, 400], [300, 400]], [[500, 400], [700, 400]],
  )]));
  const before = JSON.stringify(data);
  const scene = createMapScene(data);
  const labels = scene.queryLabels(whole);
  assert.equal(labels.length, 1);
  near(labels[0].length, 600);
  assert.equal(labels[0].points.length, 4);
  assert.ok(labelPlacements(labels[0], whole, 500).length > 0);
  assert.equal(JSON.stringify(data), before);
});

test('disconnected chains never bridge gaps and every visible chain can be labeled', () => {
  const scene = createMapScene(fixture([], [street('Main Street',
    [[100, 400], [300, 400]], [[700, 400], [900, 400]],
  )]));
  const labels = scene.queryLabels(whole);
  assert.equal(labels.length, 2);
  assert.deepEqual(scene.queryLabels({ x: 400, y: 350, w: 200, h: 100 }), []);
  for (const label of labels) {
    assert.deepEqual(labelPlacements(label, whole, 300), []);
    const placements = labelPlacements(label, whole, 100);
    assert.ok(placements.length > 0);
    for (const placement of placements) assert.ok(placement.x <= 300 || placement.x >= 700);
  }
  assert.equal(scene.queryLabels({ x: 750, y: 350, w: 100, h: 100 }).length, 1);
});

test('same-street branch junctions are not arbitrarily joined through a turn', () => {
  const scene = createMapScene(fixture([], [street('Branch Road',
    [[100, 400], [500, 400]], [[500, 400], [900, 400]], [[500, 400], [500, 700]],
  )]));
  const labels = scene.queryLabels(whole);
  assert.equal(labels.length, 3);
  for (const label of labels) assert.equal(label.points.length, 2);
});

test('closed connected loops terminate and remain a single chain', () => {
  const scene = createMapScene(fixture([], [street('Loop Road',
    [[100, 100], [300, 100]], [[300, 300], [300, 100]],
    [[300, 300], [100, 300]], [[100, 100], [100, 300]],
  )]));
  const [label] = scene.queryLabels(whole);
  near(label.length, 800);
  assert.deepEqual(label.points[0], label.points.at(-1));
  assert.equal(label.points.length, 5);
});

test('label fitting uses only the visible portion even when global midpoint is offscreen', () => {
  const scene = createMapScene(fixture([], [street('Long Street', [[100, 400], [900, 400]])]));
  const view = { x: 700, y: 350, w: 150, h: 100 };
  const [label] = scene.queryLabels(view);
  const placements = labelPlacements(label, view, 100);
  assert.ok(placements.length > 0);
  for (const { x, y, angle } of placements) {
    assert.ok(x - 50 >= view.x && x + 50 <= view.x + view.w);
    near(y, 400);
    near(angle, 0);
  }
  assert.deepEqual(labelPlacements(label, view, 160), []);
});

test('label directions remain upright for reversed, vertical, and diagonal roads', () => {
  for (const points of [
    [[900, 400], [100, 400]], [[500, 700], [500, 100]],
    [[900, 700], [100, 100]], [[100, 700], [900, 100]],
  ]) {
    const scene = createMapScene(fixture([], [street('Main Street', points)]));
    const placements = labelPlacements(scene.queryLabels(whole)[0], whole, 100);
    assert.ok(placements.length > 0);
    for (const { x, y, angle } of placements) {
      assert.ok(angle >= -Math.PI / 2 && angle <= Math.PI / 2);
      assert.ok(pointDistance([x, y], points[0], points[1]) < 1e-8);
    }
  }
});

test('a sharp corner or invisible excursion cannot supply a falsely long label span', () => {
  const label = { points: [[0, 50], [80, 50], [80, 130]] };
  assert.deepEqual(labelPlacements(label, { x: -10, y: 0, w: 200, h: 200 }, 100), []);
  const outside = { points: [[0, 50], [50, 50], [50, -100], [150, -100], [150, 50], [200, 50]] };
  assert.deepEqual(labelPlacements(outside, { x: 0, y: 0, w: 200, h: 100 }, 100), []);
  assert.deepEqual(labelPlacements(label, whole, 0), []);
  assert.deepEqual(labelPlacements(label, whole, Infinity), []);
});

test('scene projection, simplification, and labels never mutate source data', () => {
  const data = freezeDeep(fixture([
    road('residential', [[100, 400], [500, 401], [900, 400]]),
  ], [street('Main Street', [[100, 400], [900, 400]])]));
  const before = JSON.stringify(data);
  const scene = createMapScene(data);
  const groups = scene.queryRoads(whole, 4);
  const labels = scene.queryLabels(whole);
  labelPlacements(labels[0], whole, 100);
  groups[0].lines[0][0][0] = -999;
  labels[0].points[0][0] = -999;
  assert.equal(JSON.stringify(data), before);
});
