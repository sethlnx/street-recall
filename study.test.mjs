import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStudyDeck, orderStudyStreets } from './study.mjs';
import { selectStreet } from './scheduler.mjs';

function fixture() {
  return {
    areas: [
      { id: 'west', name: 'West', description: 'Western rectangle', bounds: { south: 0, north: 3, west: -4, east: 0 } },
      { id: 'east', name: 'East', description: 'Eastern rectangle', bounds: { south: -2, north: 2, west: 0, east: 5 } },
      { id: 'empty', name: 'Empty', description: 'No eligible streets', bounds: { south: 3, north: 4, west: -4, east: 5 } },
    ],
    streets: [
      {
        id: 'Southwest 1st Street', name: 'Southwest 1st Street',
        lines: [[[-3, 1], [3, 1]], [[8, 1], [9, 1]]],
        parts: {
          west: [[[-3, 1], [0, 1]]],
          east: [[[0, 1], [3, 1]], [[3, 1], [4, 1]]],
          outside: [[[8, 1], [9, 1]]],
        },
      },
      {
        id: 'East Court Avenue', name: 'East Court Avenue',
        lines: [[[1, 0], [2, 0]]],
        parts: { east: [[[1, 0], [2, 0]]] },
      },
      {
        id: 'Outside Road', name: 'Outside Road',
        lines: [[[8, 2], [9, 2]]],
        parts: { outside: [[[8, 2], [9, 2]]] },
      },
    ],
  };
}

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

test('one area selects eligible streets and highlights their full mapped geometry', () => {
  const deck = buildStudyDeck(fixture(), ['west']);
  assert.deepEqual(deck.streets, [{
    id: 'Southwest 1st Street', name: 'Southwest 1st Street',
    lines: [[[-3, 1], [3, 1]], [[8, 1], [9, 1]]],
  }]);
  assert.deepEqual(deck.bounds, { south: 0, north: 3, west: -4, east: 0 });
});

test('multiple areas include a shared street once with its full mapped geometry', () => {
  const deck = buildStudyDeck(fixture(), ['east', 'west']);
  assert.deepEqual(deck.streets, [
    {
      id: 'Southwest 1st Street', name: 'Southwest 1st Street',
      lines: [[[-3, 1], [3, 1]], [[8, 1], [9, 1]]],
    },
    {
      id: 'East Court Avenue', name: 'East Court Avenue',
      lines: [[[1, 0], [2, 0]]],
    },
  ]);
  assert.deepEqual(deck.bounds, { south: -2, north: 3, west: -4, east: 5 });
  assert.deepEqual(deck.areas, [
    { id: 'west', name: 'West', description: 'Western rectangle', bounds: { south: 0, north: 3, west: -4, east: 0 } },
    { id: 'east', name: 'East', description: 'Eastern rectangle', bounds: { south: -2, north: 2, west: 0, east: 5 } },
  ]);
});

test('an area with no eligible streets returns an empty deck with its metadata and bounds', () => {
  const deck = buildStudyDeck(fixture(), ['empty']);
  assert.deepEqual(deck.streets, []);
  assert.deepEqual(deck.bounds, { south: 3, north: 4, west: -4, east: 5 });
  assert.deepEqual(deck.areas.map(area => area.id), ['empty']);
});

test('rejects empty, repeated, and unknown selection IDs rather than silently changing the deck', () => {
  const data = fixture();
  for (const ids of [[], ['west', 'west'], ['missing'], ['west', 'missing'], ['toString'], ['__proto__'], null, 'west']) {
    assert.throws(() => buildStudyDeck(data, ids), RangeError);
  }
});

test('building and modifying a deck cannot change source geometry, metadata, or selection', () => {
  const data = freezeDeep(fixture());
  const before = JSON.stringify(data);
  const selection = Object.freeze(['east', 'west']);
  const deck = buildStudyDeck(data, selection);
  deck.streets[0].lines[0][0][0] = 100;
  deck.streets[0].lines.push([[100, 100], [101, 101]]);
  deck.areas[0].name = 'Changed';
  deck.areas[0].bounds.west = 100;
  deck.bounds.west = 100;
  assert.equal(JSON.stringify(data), before);
  assert.deepEqual(selection, ['east', 'west']);
});

test('area filtering preserves introduction priorities while due reviews still win', () => {
  const data = fixture();
  data.streets[0].priority = 2;
  data.streets[1].priority = 0;
  data.streets[2].priority = 0;
  const deck = orderStudyStreets(buildStudyDeck(data, ['west', 'east']).streets, () => 0);
  assert.equal(selectStreet(deck, {}, 100).id, 'East Court Avenue');
  assert.equal(selectStreet(deck, { 'East Court Avenue': { due: 101 } }, 100).id, 'Southwest 1st Street');
  assert.equal(selectStreet(deck, { 'Southwest 1st Street': { due: 100 } }, 100).id, 'Southwest 1st Street');
});

test('longer corridors lead within a tier using only the selected street sections', () => {
  const data = fixture();
  data.streets[0].priority = 0;
  data.streets[0].parts.east = [[[0, 1], [0.1, 1]]];
  data.streets[1].priority = 0;
  const east = orderStudyStreets(buildStudyDeck(data, ['east']).streets, () => 0.999999);
  assert.equal(selectStreet(east, {}, 100).id, 'East Court Avenue');
  const combined = orderStudyStreets(buildStudyDeck(data, ['east', 'west']).streets, () => 0.999999);
  assert.equal(selectStreet(combined, {}, 100).id, 'Southwest 1st Street');
});
