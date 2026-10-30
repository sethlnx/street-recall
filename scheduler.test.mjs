import test from 'node:test';
import assert from 'node:assert/strict';
import { schedule, selectStreet, validCard } from './scheduler.mjs';

const MINUTE = 60_000;
const DAY = 86_400_000;
const now = 1_800_000_000_000;

test('new streets use distinct learning and review intervals', () => {
  for (const [rating, interval] of [['again', MINUTE], ['hard', 6 * MINUTE], ['good', DAY], ['easy', 4 * DAY]]) {
    const card = schedule(null, rating, now);
    assert.equal(card.due, now + interval);
    assert.equal(card.interval, interval);
    assert.equal(card.reviews, 1);
    assert.equal(card.lapses, 0);
    assert.ok(validCard(card));
  }
});

test('successful learning graduates to a day and later intervals grow', () => {
  const learning = schedule(null, 'again', now);
  const graduated = schedule(learning, 'good', learning.due);
  assert.equal(graduated.interval, DAY);
  const reviewed = schedule(graduated, 'good', graduated.due);
  assert.equal(reviewed.interval, 198_720_000);
  assert.equal(reviewed.reviews, 3);
  assert.equal(learning.interval, MINUTE);
});

test('forgetting a mature street returns to learning, with bounded ease', () => {
  let card = schedule(null, 'easy', now);
  card = schedule(card, 'again', card.due);
  assert.equal(card.interval, MINUTE);
  assert.equal(card.lapses, 1);
  for (let i = 0; i < 30; i++) card = schedule(card, 'again', card.due);
  assert.equal(card.ease, 1.3);
  assert.equal(card.lapses, 31);
  assert.ok(validCard(card));
  assert.equal(schedule(card, 'good', card.due).interval, DAY);
});

test('hard mature reviews grow slowly while easy reviews grow faster', () => {
  const prior = schedule(null, 'good', now);
  const hard = schedule(prior, 'hard', prior.due);
  const good = schedule(prior, 'good', prior.due);
  const easy = schedule(prior, 'easy', prior.due);
  assert.equal(hard.interval, Math.round(DAY * 1.2));
  assert.ok(hard.interval < good.interval && good.interval < easy.interval);
  assert.equal(prior.ease, 2.5);
});

test('oldest due review precedes new cards, including at the exact due time', () => {
  const streets = [{ id: 'new' }, { id: 'later' }, { id: 'oldest' }];
  const cards = { later: { ...schedule(null, 'good', now), due: now }, oldest: { ...schedule(null, 'good', now), due: now - 1 } };
  assert.equal(selectStreet(streets, cards, now).id, 'oldest');
  assert.equal(selectStreet(streets.slice(0, 2), cards, now).id, 'later');
  assert.equal(selectStreet(streets, cards, now - 2).id, 'new');
});

test('completed decks wait until due, ignoring cards outside this deck', () => {
  const streets = [{ id: 'Main' }];
  const cards = { Main: schedule(null, 'good', now), other: { due: now - 1 } };
  assert.equal(selectStreet(streets, cards, now), null);
  assert.equal(selectStreet(streets, cards, cards.Main.due).id, 'Main');
});

test('corrupt saved schedules cannot become invisible or immediately repeating cards', () => {
  const card = schedule(null, 'good', now);
  for (const patch of [{ due: null }, { interval: 0 }, { reviews: 0 }, { ease: 1 }, { lapses: -1 }, { due: Infinity }, { reviews: 1.5 }]) {
    assert.equal(validCard({ ...card, ...patch }), false);
  }
  assert.equal(validCard(null), false);
  assert.throws(() => schedule(card, 'unknown', now), RangeError);
});
