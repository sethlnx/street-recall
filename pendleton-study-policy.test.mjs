import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifyPendletonStreet, connectPendletonStreets, connectPolylines } from './tools/pendleton-study-policy.mjs';
import { rankStreetsByImportance } from './tools/street-rank.mjs';
import { buildStudyDeck, orderStudyStreets } from './study.mjs';
import { selectStreet } from './scheduler.mjs';

test('multi-area tertiary bridges like North Main Street stay tertiary while short single-area stubs do not promote', () => {
  assert.equal(classifyPendletonStreet('North Main Street', { tertiary: 84, residential: 835 }, ['downtown', 'north']).roadClass, 'tertiary');
  assert.equal(classifyPendletonStreet('Southeast 3rd Drive', { tertiary: 68, unclassified: 149 }, ['east']).roadClass, 'unclassified');
  assert.equal(classifyPendletonStreet('Empty Road', { primary: 500 }, []), null);
  assert.equal(classifyPendletonStreet('Tiny Alley', { residential: 40 }, ['east']), null);
});

test('bundled Pendleton cards are ordered by importance in every deck, and due reviews still go first', async () => {
  const data = JSON.parse(await readFile(new URL('./data/pendleton.json', import.meta.url), 'utf8'));
  assert.equal(data.streets.length, 251);
  assert.deepEqual(data.streets.map(street => street.priority), data.streets.map((_, rank) => rank));
  assert.deepEqual(data.streets.map(street => street.name), rankStreetsByImportance(data.streets).map(street => street.name));
  assert.equal(data.streets[0].roadClass, 'primary');
  assert.equal(data.streets.at(-1).roadClass, 'residential');

  const rankOf = new Map(data.streets.map(street => [street.id, street.priority]));
  for (const areaIds of [['downtown'], ['north'], data.areas.map(area => area.id)]) {
    const deck = orderStudyStreets(buildStudyDeck(data, areaIds).streets, () => 0);
    assert.ok(deck.length > 0);
    assert.deepEqual(deck.map(street => rankOf.get(street.id)),
      deck.map(street => rankOf.get(street.id)).sort((a, b) => a - b));
  }

  const fullDeck = orderStudyStreets(buildStudyDeck(data, data.areas.map(area => area.id)).streets, () => 0);
  assert.equal(selectStreet(fullDeck, {}, 100).id, data.streets[0].id);
  assert.equal(
    selectStreet(fullDeck, { 'Northwest F Avenue': { due: 100 } }, 100).id,
    'Northwest F Avenue',
  );
});

test('Oregon-Washington Highway and split Pendleton corridors connect into continuous polylines', async () => {
  const data = JSON.parse(await readFile(new URL('./data/pendleton.json', import.meta.url), 'utf8'));
  const byName = new Map(data.streets.map(street => [street.name, street]));

  for (const name of [
    'Airport Road',
    'Rieth Road',
    'Southwest Emigrant Avenue',
    'Southeast Dorion Avenue',
    'Southeast Byers Avenue',
    'Southwest Byers Avenue',
    'Northwest 11th Street',
    'Southeast 12th Street',
  ]) {
    const street = byName.get(name);
    assert.equal(street.lines.length, 1, `${name} should form one connected polyline`);
    assert.ok(street.lines[0].length >= 2);
  }

  // The one-way "Washington-Oregon Highway" carriageway is part of this card, so
  // the road is a connected loop of chains rather than a single polyline.
  assert.ok(!byName.has('Washington-Oregon Highway'));
  const owh = byName.get('Oregon-Washington Highway');
  const ends = new Set(owh.lines.flatMap(line => [line[0], line[line.length - 1]].map(point => point.join(','))));
  assert.ok(ends.has('-118.7776974,45.6627361'));
  assert.ok(ends.has('-118.7495,45.679570725134546'));
  assert.equal(connectPolylines(owh.lines).length, owh.lines.length);
  const joined = new Map(owh.lines.flatMap(line => [line[0], line[line.length - 1]]).map(point => [point.join(','), 0]));
  for (const line of owh.lines) {
    for (const point of [line[0], line[line.length - 1]]) joined.set(point.join(','), joined.get(point.join(',')) + 1);
  }
  assert.ok(owh.lines.every(line => [line[0], line[line.length - 1]].some(point => joined.get(point.join(',')) > 1)),
    'every chain of the highway meets another chain');

  // Idempotent when re-run on already connected streets
  const clipBox = (points, rect) => [points.filter(([lon, lat]) =>
    lon >= rect.west && lon <= rect.east && lat >= rect.south && lat <= rect.north)].filter(line => line.length >= 2);
  const reconnected = connectPendletonStreets(
    [owh],
    data.roads,
    data.areas,
    clipBox,
  );
  assert.equal(reconnected[0].lines.length, owh.lines.length);
  assert.equal(connectPolylines([[[0, 0], [1, 0]], [[2, 0], [1, 0]]]).length, 1);
});
