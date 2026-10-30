import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifyPendletonStreet, connectPendletonStreets, connectPolylines } from './tools/pendleton-study-policy.mjs';
import { buildStudyDeck, orderStudyStreets } from './study.mjs';
import { selectStreet } from './scheduler.mjs';

const card = (id, metersByClass, areaIds) => ({
  id,
  name: id,
  ...classifyPendletonStreet(id, metersByClass, areaIds),
});

test('major throughways introduce before local streets and order important areas first within each class', () => {
  const streets = [
    card('Northwest 50th Street', { unclassified: 429 }, ['west']),
    card('Johns Lane', { unclassified: 3182 }, ['north']),
    card('Southwest 44th Street', { residential: 1612 }, ['west']),
    card('Northwest Horn Avenue', { residential: 918 }, ['north']),
    card('Northwest Furnish Avenue', { residential: 1186 }, ['north', 'west']),
    card('Southeast 4th Street', { residential: 750 }, ['downtown']),
    card('Southeast Byers Avenue', { unclassified: 399, residential: 1574 }, ['downtown', 'east']),
    card('Murietta Road', { tertiary: 1956 }, ['west']),
    card('Southwest Hailey Avenue', { tertiary: 1421, residential: 1661 }, ['west', 'southwest', 'south']),
    card('Southeast Emigrant Avenue', { tertiary: 715, residential: 75 }, ['downtown', 'east']),
    card('Airport Road', { secondary: 1807, tertiary: 2975 }, ['west']),
    card('Tutuilla Creek Road', { secondary: 3261 }, ['west', 'southwest', 'south']),
    card('South Main Street', { secondary: 328, tertiary: 595, residential: 389 }, ['downtown', 'south']),
    card('Rieth Road', { primary: 495, tertiary: 2374 }, ['west']),
    card('Westgate', { primary: 3202 }, ['west', 'southwest']),
    card('Southeast Court Avenue', { primary: 2044, secondary: 592 }, ['downtown', 'east']),
  ];

  const ordered = orderStudyStreets(streets, () => 0);
  assert.deepEqual(ordered.map(street => street.id), [
    'Southeast Court Avenue',
    'Westgate',
    'Rieth Road',
    'South Main Street',
    'Tutuilla Creek Road',
    'Airport Road',
    'Southeast Emigrant Avenue',
    'Southwest Hailey Avenue',
    'Murietta Road',
    'Southeast Byers Avenue',
    'Southeast 4th Street',
    'Northwest Furnish Avenue',
    'Northwest Horn Avenue',
    'Southwest 44th Street',
    'Johns Lane',
    'Northwest 50th Street',
  ]);
  assert.equal(selectStreet(ordered, {}, 100).id, 'Southeast Court Avenue');
});

test('multi-area tertiary bridges like North Main Street stay tertiary while short single-area stubs do not promote', () => {
  const northMain = classifyPendletonStreet('North Main Street', { tertiary: 84, residential: 835 }, ['downtown', 'north']);
  assert.equal(northMain.roadClass, 'tertiary');
  assert.equal(northMain.areaTier, 0);

  const shortStub = classifyPendletonStreet('Southeast 3rd Drive', { tertiary: 68, unclassified: 149 }, ['east']);
  assert.equal(shortStub.roadClass, 'unclassified');
  assert.ok(shortStub.priority > northMain.priority);

  assert.equal(classifyPendletonStreet('Empty Road', { primary: 500 }, []), null);
  assert.equal(classifyPendletonStreet('Tiny Alley', { residential: 40 }, ['east']), null);
});

test('bundled Pendleton dataset prioritizes major throughways and central areas while preserving due-review precedence', async () => {
  const data = JSON.parse(await readFile(new URL('./data/pendleton.json', import.meta.url), 'utf8'));
  assert.equal(data.streets.length, 251);
  assert.ok(data.streets.every(street => Number.isInteger(street.priority) && street.priority >= 0));

  const downtownDeck = orderStudyStreets(buildStudyDeck(data, ['downtown']).streets, () => 0);
  assert.equal(downtownDeck.length, 33);
  assert.deepEqual(downtownDeck.slice(0, 8).map(street => street.id), [
    'Southeast Court Avenue',
    'Southeast Dorion Avenue',
    'Southwest Dorion Avenue',
    'Southwest Court Avenue',
    'Oregon-Washington Highway',
    'South Main Street',
    'Southwest Emigrant Avenue',
    'Southwest Frazer Avenue',
  ]);

  const northDeck = orderStudyStreets(buildStudyDeck(data, ['north']).streets, () => 0);
  assert.deepEqual(northDeck.slice(0, 4).map(street => street.id), [
    'North Main Street',
    'Northwest 10th Street',
    'Northwest 4th Street',
    'Northwest 3rd Street',
  ]);
  assert.deepEqual(northDeck.slice(-4).map(street => street.id), [
    'Snyder Road',
    'Campbell Road',
    'Johns Lane',
    'Lee Street',
  ]);

  const allAreasIds = data.areas.map(area => area.id);
  const fullDeck = orderStudyStreets(buildStudyDeck(data, allAreasIds).streets, () => 0);
  assert.deepEqual(fullDeck.slice(0, 5).map(street => street.id), [
    'Oregon-Washington Highway',
    'Southwest Court Avenue',
    'Southeast Court Avenue',
    'Southwest Dorion Avenue',
    'Southeast Dorion Avenue',
  ]);
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
