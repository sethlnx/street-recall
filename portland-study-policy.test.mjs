import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifyPortlandStreet } from './tools/portland-study-policy.mjs';
import { rankStreetsByImportance } from './tools/street-rank.mjs';
import { buildStudyDeck, orderStudyStreets } from './study.mjs';
import { selectStreet } from './scheduler.mjs';

test('major numbered avenues stay while minor numbered collectors and residential roads are pruned', () => {
  assert.equal(classifyPortlandStreet('Southeast 82nd Avenue', { primary: 1200 }).roadClass, 'primary');
  assert.equal(classifyPortlandStreet('Northeast 122nd Avenue', { secondary: 1600 }).roadClass, 'secondary');
  assert.equal(classifyPortlandStreet('Northeast 53rd Avenue', { tertiary: 1600 }), null);
  assert.equal(classifyPortlandStreet('Northeast 53rd Avenue', { residential: 1600 }), null);
  assert.equal(classifyPortlandStreet('Quiet Lane', { residential: 5000, unclassified: 2000 }), null);
  assert.equal(classifyPortlandStreet('North Mississippi Avenue', { tertiary: 1200 }).roadClass, 'tertiary');
  assert.equal(classifyPortlandStreet('Northeast 53RD Avenue', { tertiary: 1600 }), null);
});

test('a tiny primary stub cannot promote a local road or outrank its meaningful secondary section', () => {
  assert.equal(classifyPortlandStreet('Local Road', { primary: 89, residential: 5000 }), null);
  assert.equal(classifyPortlandStreet('Mixed Road', { primary: 89, secondary: 90 }).roadClass, 'secondary');
});

test('bundled Portland cards are ordered by importance in every deck, and due reviews still go first', async () => {
  const data = JSON.parse(await readFile(new URL('./data/portland.json', import.meta.url), 'utf8'));
  assert.deepEqual(data.streets.map(street => street.priority), data.streets.map((_, rank) => rank));
  assert.deepEqual(data.streets.map(street => street.name), rankStreetsByImportance(data.streets).map(street => street.name));
  assert.equal(data.streets[0].roadClass, 'primary');
  assert.equal(data.streets.at(-1).roadClass, 'tertiary');

  const rankOf = new Map(data.streets.map(street => [street.id, street.priority]));
  for (const areaIds of [['central'], ['north'], data.areas.map(area => area.id)]) {
    const deck = orderStudyStreets(buildStudyDeck(data, areaIds).streets, () => 0);
    assert.ok(deck.length > 0);
    assert.deepEqual(deck.map(street => rankOf.get(street.id)),
      deck.map(street => rankOf.get(street.id)).sort((a, b) => a - b));
  }

  const deck = orderStudyStreets(buildStudyDeck(data, data.areas.map(area => area.id)).streets, () => 0);
  assert.equal(selectStreet(deck, {}, 100).id, data.streets[0].id);
  const last = data.streets.at(-1).id;
  assert.equal(selectStreet(deck, { [last]: { due: 100 } }, 100).id, last);
  assert.equal(selectStreet(deck, { [last]: { due: 100 } }, 99).id, data.streets[0].id);
});
