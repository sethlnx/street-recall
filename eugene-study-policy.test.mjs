import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { rankStreetsByImportance } from './tools/street-rank.mjs';
import { buildStudyDeck, orderStudyStreets } from './study.mjs';
import { selectStreet } from './scheduler.mjs';

test('bundled Eugene cards are major roads ordered by importance in every ward deck, and due reviews still go first', async () => {
  const data = JSON.parse(await readFile(new URL('./data/eugene.json', import.meta.url), 'utf8'));
  assert.deepEqual(data.areas.map(area => area.id), Array.from({ length: 8 }, (_, i) => `ward-${i + 1}`));
  assert.deepEqual(data.streets.map(street => street.priority), data.streets.map((_, rank) => rank));
  assert.deepEqual(data.streets.map(street => street.name), rankStreetsByImportance(data.streets).map(street => street.name));
  assert.ok(data.streets.every(street => ['primary', 'secondary', 'tertiary'].includes(street.roadClass)));
  assert.equal(data.streets[0].roadClass, 'primary');
  assert.equal(data.streets.at(-1).roadClass, 'tertiary');

  const rankOf = new Map(data.streets.map(street => [street.id, street.priority]));
  for (const areaIds of [...data.areas.map(area => [area.id]), data.areas.map(area => area.id)]) {
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
