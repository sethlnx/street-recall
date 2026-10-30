import test from 'node:test';
import assert from 'node:assert/strict';
import { rankStreetsByImportance } from './tools/street-rank.mjs';

// An east-west line of `km` kilometres at the equator (1° of longitude ≈ 111.2 km).
const road = (name, roadClass, km) => ({ name, roadClass, lines: [[[0, 0], [km / 111.2, 0]]] });

test('roads rank by class first, then by length, then by name', () => {
  const input = [
    road('Local Lane', 'residential', 5),
    road('Short Arterial', 'primary', 1),
    road('Long Collector', 'tertiary', 9),
    road('Long Arterial', 'primary', 4),
    road('Cut-through', 'unclassified', 2),
    road('Middle Road', 'secondary', 3),
    road('B Twin', 'secondary', 2),
    road('A Twin', 'secondary', 2),
    road('Footpath Street', 'living_street', 8),
  ];
  const ranked = rankStreetsByImportance(input);
  assert.deepEqual(ranked.map(street => street.name), [
    'Long Arterial', 'Short Arterial', 'Middle Road', 'A Twin', 'B Twin',
    'Long Collector', 'Cut-through', 'Local Lane', 'Footpath Street',
  ]);
  assert.deepEqual(ranked.map(street => street.priority), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(input[0].priority, undefined);
});

test('an unknown road class is an error, not a silent last place', () => {
  assert.throws(() => rankStreetsByImportance([road('Mystery Road', 'bridleway', 1)]), /Unknown road class/);
});
