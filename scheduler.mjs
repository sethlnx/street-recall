const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const RATINGS = ['again', 'hard', 'good', 'easy'];

// A small SM-2-inspired scheduler, not Anki's FSRS implementation.
// Short learning steps precede day-based review intervals.
export function schedule(previous, rating, now = Date.now()) {
  if (!RATINGS.includes(rating)) throw new RangeError('Unknown recall rating');
  const card = previous ?? { due: now, interval: 0, ease: 2.5, reviews: 0, lapses: 0 };
  let { interval, ease, lapses } = card;
  if (rating === 'again') {
    interval = MINUTE;
    ease = Math.max(1.3, ease - 0.2);
    if (card.reviews > 0) lapses += 1;
  } else if (rating === 'hard') {
    interval = interval < DAY ? 6 * MINUTE : Math.round(interval * 1.2);
    ease = Math.max(1.3, ease - 0.15);
  } else if (rating === 'good') {
    interval = interval < DAY ? DAY : Math.round(interval * ease);
  } else {
    interval = interval < DAY ? 4 * DAY : Math.round(interval * ease * 1.3);
    ease += 0.15;
  }
  return { due: now + interval, interval, ease, reviews: card.reviews + 1, lapses };
}

export function intervalLabel(milliseconds) {
  if (milliseconds < 3_600_000) return `${Math.max(1, Math.round(milliseconds / MINUTE))} min`;
  if (milliseconds < DAY) return `${Math.round(milliseconds / 3_600_000)} hr`;
  const days = Math.round(milliseconds / DAY * 10) / 10;
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

export function selectStreet(streets, cards, now = Date.now()) {
  let next = null;
  for (const street of streets) {
    const card = Object.hasOwn(cards, street.id) ? cards[street.id] : null;
    if (card && card.due <= now && (!next || card.due < cards[next.id].due)) next = street;
  }
  return next ?? streets.find(street => !Object.hasOwn(cards, street.id)) ?? null;
}

export function validCard(card) {
  return card !== null && typeof card === 'object'
    && ['due', 'interval', 'ease', 'reviews', 'lapses'].every(key => Number.isFinite(card[key]))
    && card.due >= 0 && card.interval > 0 && card.ease >= 1.3
    && Number.isSafeInteger(card.reviews) && card.reviews > 0
    && Number.isSafeInteger(card.lapses) && card.lapses >= 0 && card.lapses <= card.reviews;
}
