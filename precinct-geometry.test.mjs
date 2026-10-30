import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareArea, pointInArea, clipLinesToArea } from './tools/precinct-geometry.mjs';

const rectangle = (west, south, east, north) => [
  [west, south], [east, south], [east, north], [west, north], [west, south],
];
const polygon = (...rings) => ({ type: 'Polygon', coordinates: rings });
const multiPolygon = (...polygons) => ({ type: 'MultiPolygon', coordinates: polygons });

function assertLinesClose(actual, expected, tolerance = 1e-11) {
  assert.equal(actual.length, expected.length, 'polyline count');
  for (let i = 0; i < expected.length; i += 1) {
    assert.equal(actual[i].length, expected[i].length, `line ${i} vertex count`);
    for (let j = 0; j < expected[i].length; j += 1) {
      for (let axis = 0; axis < 2; axis += 1) {
        assert.ok(Math.abs(actual[i][j][axis] - expected[i][j][axis]) <= tolerance,
          `line ${i}, vertex ${j}, axis ${axis}: ${actual[i][j][axis]} versus ${expected[i][j][axis]}`);
      }
    }
  }
}

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

test('diagonal polygon membership differs from its bounding rectangle', () => {
  const area = prepareArea(polygon([[0, 0], [4, 0], [0, 4], [0, 0]]));
  assert.equal(pointInArea([3, 3], area), false);
  assert.equal(pointInArea([1, 1], area), true);
  assert.equal(pointInArea([2, 2], area), true);
  assert.deepEqual(clipLinesToArea([[[3, 2], [3, 3]]], area), []);
  assert.deepEqual(clipLinesToArea([[[-1, 1], [5, 1]]], area), [[[0, 1], [3, 1]]]);
});

test('concave polygon removes an interior bounding-box gap', () => {
  const area = prepareArea(polygon([
    [0, 0], [4, 0], [4, 4], [3, 4], [3, 1], [1, 1], [1, 4], [0, 4], [0, 0],
  ]));
  assert.equal(pointInArea([2, 3], area), false);
  assert.deepEqual(clipLinesToArea([[[-1, 3], [5, 3]]], area), [
    [[0, 3], [1, 3]], [[3, 3], [4, 3]],
  ]);
});

test('crossing segment retains exact entering and exiting intersections', () => {
  const area = prepareArea(polygon(rectangle(0, 0, 4, 4)));
  assert.deepEqual(clipLinesToArea([[[-2, 1], [6, 3]]], area), [[[0, 1.5], [4, 2.5]]]);
  assert.deepEqual(clipLinesToArea([[[6, 3], [-2, 1]]], area), [[[4, 2.5], [0, 1.5]]]);
  assert.deepEqual(clipLinesToArea([[[2, -2], [2, 6]]], area), [[[2, 0], [2, 4]]]);
});

test('hole interiors are excluded and hole boundaries are included', () => {
  const area = prepareArea(polygon(rectangle(0, 0, 6, 6), rectangle(2, 1, 4, 5)));
  assert.equal(pointInArea([3, 2], area), false);
  assert.equal(pointInArea([2, 2], area), true);
  assert.equal(pointInArea([2, 1], area), true);
  assert.equal(pointInArea([1, 2], area), true);
  assert.deepEqual(clipLinesToArea([[[-1, 2], [7, 2]]], area), [
    [[0, 2], [2, 2]], [[4, 2], [6, 2]],
  ]);
  assert.deepEqual(clipLinesToArea([[[-1, 1], [7, 1]]], area), [[[0, 1], [6, 1]]]);
  assert.deepEqual(clipLinesToArea([[[2, 0], [2, 6]]], area), [[[2, 0], [2, 6]]]);
});

test('ring winding does not change shell and hole interpretation', () => {
  const outer = rectangle(0, 0, 6, 6).reverse();
  const hole = rectangle(2, 1, 4, 5).reverse();
  const area = prepareArea(polygon(outer, hole));
  assert.deepEqual(clipLinesToArea([[[-1, 2], [7, 2]]], area), [
    [[0, 2], [2, 2]], [[4, 2], [6, 2]],
  ]);
});

test('disjoint MultiPolygon components retain separate lines', () => {
  const area = prepareArea(multiPolygon([rectangle(0, 0, 2, 2)], [rectangle(4, 0, 6, 2)]));
  assert.equal(pointInArea([3, 1], area), false);
  assert.equal(pointInArea([5, 1], area), true);
  assert.deepEqual(clipLinesToArea([[[-1, 1], [7, 1]]], area), [
    [[0, 1], [2, 1]], [[4, 1], [6, 1]],
  ]);
});

test('overlapping components are a union, not even-odd cancellation', () => {
  const area = prepareArea(multiPolygon([rectangle(0, 0, 4, 2)], [rectangle(2, 0, 6, 2)]));
  assert.equal(pointInArea([3, 1], area), true);
  assert.deepEqual(clipLinesToArea([[[-1, 1], [7, 1]]], area), [[[0, 1], [6, 1]]]);
});

test('one polygon can fill another polygon hole', () => {
  const area = prepareArea(multiPolygon(
    [rectangle(0, 0, 6, 6), rectangle(2, 1, 4, 5)],
    [rectangle(2, 1, 4, 5)],
  ));
  assert.equal(pointInArea([3, 2], area), true);
  assert.deepEqual(clipLinesToArea([[[-1, 2], [7, 2]]], area), [[[0, 2], [6, 2]]]);
});

test('shared precinct district edges do not split or duplicate a line', () => {
  const area = prepareArea(multiPolygon([rectangle(0, 0, 2, 2)], [rectangle(2, 0, 4, 2)]));
  assert.deepEqual(clipLinesToArea([[[2, -1], [2, 3]]], area), [[[2, 0], [2, 2]]]);
  assert.deepEqual(clipLinesToArea([[[-1, 1], [5, 1]]], area), [[[0, 1], [4, 1]]]);
});

test('collinear outer boundary segments include their overlap only', () => {
  const area = prepareArea(polygon(rectangle(0, 0, 4, 4)));
  assert.deepEqual(clipLinesToArea([[[-1, 0], [5, 0]]], area), [[[0, 0], [4, 0]]]);
  assert.deepEqual(clipLinesToArea([[[5, 4], [-1, 4]]], area), [[[4, 4], [0, 4]]]);
  assert.deepEqual(clipLinesToArea([[[-2, 0], [-1, 0]]], area), []);
  assert.deepEqual(clipLinesToArea([[[1, -1e-6], [3, -1e-6]]], area), []);
});

test('outside excursions are not bridged between retained source vertices', () => {
  const area = prepareArea(polygon(rectangle(0, 0, 1, 1)));
  assert.deepEqual(clipLinesToArea([[[0.5, 0.5], [2, 0.5], [2, 2], [0.5, 0.5]]], area), [
    [[0.5, 0.5], [1, 0.5]], [[1, 1], [0.5, 0.5]],
  ]);
});

test('an excursion returning to the same boundary point still starts a new line', () => {
  const area = prepareArea(polygon(rectangle(0, 0, 1, 1)));
  assert.deepEqual(clipLinesToArea([[
    [0.5, 0.5], [1, 0.5], [2, 0.5], [1, 0.5], [0.5, 0.5],
  ]], area), [
    [[0.5, 0.5], [1, 0.5]], [[1, 0.5], [0.5, 0.5]],
  ]);
});

test('separate source polylines stay separate even when endpoints meet', () => {
  const area = prepareArea(polygon(rectangle(0, 0, 4, 4)));
  const lines = [[[0, 1], [1, 1]], [[1, 1], [2, 1]]];
  assert.deepEqual(clipLinesToArea(lines, area), lines);
});

test('inside vertices remain connected and repeated points are harmless', () => {
  const area = prepareArea(polygon(rectangle(0, 0, 4, 4)));
  assert.deepEqual(clipLinesToArea([[[1, 1], [1, 1], [2, 1], [2, 2]]], area), [
    [[1, 1], [2, 1], [2, 2]],
  ]);
  assert.deepEqual(clipLinesToArea([[], [[1, 1]], [[1, 1], [1, 1]]], area), []);
});

test('vertex tangencies do not emit zero-length polylines', () => {
  const area = prepareArea(polygon(rectangle(0, 0, 4, 4)));
  assert.deepEqual(clipLinesToArea([[[-1, 1], [1, -1]]], area), []);
  assert.deepEqual(clipLinesToArea([[[-1, -1], [0, 0]]], area), []);
  assert.equal(pointInArea([0, 0], area), true);
});

test('edge-tree branch traversal handles a many-edge polygon', () => {
  const ring = Array.from({ length: 64 }, (_, i) => {
    const angle = i * Math.PI * 2 / 64;
    return [Math.cos(angle), Math.sin(angle)];
  });
  ring.push([...ring[0]]);
  const area = prepareArea(polygon(ring));
  assert.equal(pointInArea([0, 0], area), true);
  assert.equal(pointInArea([0.9, 0.9], area), false);
  assert.equal(pointInArea(ring[16], area), true);
  assertLinesClose(clipLinesToArea([[[-2, 0], [2, 0]]], area), [[[-1, 0], [1, 0]]]);
});

test('small Portland-scale intersections are not mistaken for parallel edges', () => {
  const west = -122.68;
  const south = 45.52;
  const size = 0.00001;
  const area = prepareArea(polygon(rectangle(west, south, west + size, south + size)));
  assertLinesClose(clipLinesToArea([[
    [west - size, south + size / 2], [west + size * 2, south + size / 2],
  ]], area), [[
    [west, south + size / 2], [west + size, south + size / 2],
  ]]);
});

test('preparation and clipping do not mutate or alias source coordinates', () => {
  const geometry = freezeDeep(polygon(rectangle(0, 0, 4, 4)));
  const lines = freezeDeep([[[1, 1], [2, 2]]]);
  const before = JSON.stringify({ geometry, lines });
  const area = prepareArea(geometry);
  const clipped = clipLinesToArea(lines, area);
  assert.deepEqual(clipped, lines);
  assert.notEqual(clipped[0], lines[0]);
  assert.notEqual(clipped[0][0], lines[0][0]);
  clipped[0][0][0] = 99;
  assert.equal(JSON.stringify({ geometry, lines }), before);
  assert.equal(pointInArea([1, 1], area), true);
});

test('prepared geometry is independent of later source mutations', () => {
  const geometry = polygon(rectangle(0, 0, 4, 4));
  const area = prepareArea(geometry);
  geometry.coordinates[0][0][0] = 100;
  geometry.coordinates[0][1][1] = 100;
  assert.equal(pointInArea([1, 1], area), true);
  assert.deepEqual(clipLinesToArea([[[-1, 1], [5, 1]]], area), [[[0, 1], [4, 1]]]);
});

test('empty geometry produces no membership and no clipped lines', () => {
  for (const geometry of [polygon(), multiPolygon()]) {
    const area = prepareArea(geometry);
    assert.equal(pointInArea([0, 0], area), false);
    assert.deepEqual(clipLinesToArea([[[-1, 0], [1, 0]]], area), []);
  }
  assert.throws(() => prepareArea({ type: 'LineString', coordinates: [] }), TypeError);
});
