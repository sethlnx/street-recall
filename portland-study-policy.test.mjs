import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPortlandStreet } from './tools/portland-study-policy.mjs';
import { orderStudyStreets } from './study.mjs';
import { selectStreet } from './scheduler.mjs';

const card = (id, meters) => ({ id, ...classifyPortlandStreet(id, meters) });

test('named arterials introduce before numbered arterials and lower-ranked collectors', () => {
  const streets = [
    card('Northeast 33rd Avenue', { secondary: 1000 }),
    card('North Mississippi Avenue', { tertiary: 1000 }),
    card('Northeast 82nd Avenue', { primary: 1000 }),
    card('Southeast Hawthorne Boulevard', { secondary: 1000 }),
    card('West Burnside Street', { primary: 1000 }),
  ];
  const ordered = orderStudyStreets(streets, () => 0);
  assert.deepEqual(ordered.map(street => street.id), [
    'West Burnside Street', 'Southeast Hawthorne Boulevard',
    'Northeast 82nd Avenue', 'North Mississippi Avenue', 'Northeast 33rd Avenue',
  ]);
  assert.equal(selectStreet(ordered, {}, 100).id, 'West Burnside Street');
  assert.equal(streets[0].id, 'Northeast 33rd Avenue');
});

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
  const secondary = classifyPortlandStreet('Mixed Road', { primary: 89, secondary: 90 });
  assert.equal(secondary.roadClass, 'secondary');
  assert.ok(secondary.priority > classifyPortlandStreet('Arterial Road', { primary: 90 }).priority);
});

test('due reviews still beat the highest-priority unseen major street', () => {
  const streets = orderStudyStreets([
    card('West Burnside Street', { primary: 1000 }),
    card('Northeast 33rd Avenue', { secondary: 1000 }),
  ], () => 0);
  const cards = { 'Northeast 33rd Avenue': { due: 100 } };
  assert.equal(selectStreet(streets, cards, 100).id, 'Northeast 33rd Avenue');
  assert.equal(selectStreet(streets, cards, 99).id, 'West Burnside Street');
});
