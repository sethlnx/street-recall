import { RATINGS, schedule, intervalLabel, selectStreet, validCard } from './scheduler.mjs';
import { buildStudyDeck, orderStudyStreets } from './study.mjs';
import { MapRenderer } from './map-renderer.mjs';

const $ = id => document.getElementById(id);
const CITIES = {
  pendleton: {
    name: 'Pendleton', label: 'Pendleton, Oregon', defaultAreas: ['downtown'],
    progressKey: 'street-recall:pendleton-downtown:v1',
    labelsKey: 'street-recall:pendleton-downtown:other-names',
    areasKey: 'street-recall:pendleton:areas:v1',
    allAreasTitle: 'All Pendleton areas',
    areaDescription: 'Geographic study zones, not official neighborhoods. The most important roads introduce first; combine areas without losing your review history.',
  },
  portland: {
    name: 'Portland', label: 'Portland, Oregon', defaultAreas: ['central'],
    progressKey: 'street-recall:portland:v1',
    labelsKey: 'street-recall:portland:other-names',
    areasKey: 'street-recall:portland:areas:v1',
    allAreasTitle: 'All Portland precincts',
    areaDescription: 'Official Portland Police precincts. The most important roads introduce first. Minor streets are map context, not cards.',
    credit: { label: 'Precinct boundaries', text: 'City of Portland / Portland Police Bureau', url: 'https://www.portlandmaps.com/arcgis/rest/services/Public/CGIS_Layers/MapServer/18' },
  },
  eugene: {
    name: 'Eugene', label: 'Eugene, Oregon', defaultAreas: ['ward-3'],
    progressKey: 'street-recall:eugene:v1',
    labelsKey: 'street-recall:eugene:other-names',
    areasKey: 'street-recall:eugene:areas:v1',
    allAreasTitle: 'All Eugene wards',
    areaDescription: 'Official City of Eugene City Council wards. The most important roads introduce first. Minor streets are map context, not cards.',
    credit: { label: 'Ward boundaries', text: 'City of Eugene', url: 'https://gis.eugene-or.gov/arcgis/rest/services/Common/EugeneBoundaries/MapServer/2' },
  },
};
const CITY_KEY = 'street-recall:city';
const WIDTH = 1000;
const HEIGHT = 800;
let cards = {};
let canSave = true;
let streets = [];
let current = null;
let revealed = false;
let sessionReviews = 0;
let view = { x: 0, y: 0, w: WIDTH, h: HEIGHT };
let mapRenderer;
let project;
let mapData;
let homeView = { x: 0, y: 0, w: WIDTH, h: HEIGHT };
let areaPreferenceWarning = '';
let activeCity = CITIES.pendleton;
let activeCityId = 'pendleton';
let selectedAreaIds = [];
let minimumQuestionWidth = WIDTH / 12;
let ready = false;
let cityLoadController;
const citySessions = new Map();

function areaStatus(message, error = false) {
  $('area-status').textContent = message;
  $('area-status').dataset.error = String(error);
}

function loadAreaSelection() {
  try {
    const raw = localStorage.getItem(activeCity.areasKey);
    if (raw === null) return activeCity.defaultAreas;
    const ids = JSON.parse(raw);
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length
      || !ids.every(id => mapData.areas.some(area => area.id === id))) throw new Error('Unknown study areas');
    return ids;
  } catch {
    const defaultName = mapData.areas.find(area => area.id === activeCity.defaultAreas[0]).name;
    areaPreferenceWarning = `Saved areas could not be loaded; using ${defaultName} for this visit.`;
    return activeCity.defaultAreas;
  }
}

function createAreaChoices() {
  $('area-choices').replaceChildren();
  for (const area of mapData.areas) {
    const label = document.createElement('label');
    label.className = 'area-choice';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'study-area';
    input.value = area.id;
    input.id = `area-${area.id}`;
    const description = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = area.name;
    const detail = document.createElement('small');
    const count = mapData.streets.filter(street => Object.hasOwn(street.parts, area.id)).length;
    detail.textContent = `${count} streets · ${area.description}`;
    description.append(name, detail);
    label.append(input, description);
    $('area-choices').append(label);
  }
  $('area-options').disabled = false;
}

function applyStudyAreas(ids, persist = false) {
  const deck = buildStudyDeck(mapData, ids);
  streets = orderStudyStreets(deck.streets);
  selectedAreaIds = [...ids];
  homeView = geographicView(deck.bounds);
  for (const input of document.querySelectorAll('[name="study-area"]')) input.checked = ids.includes(input.value);
  const names = deck.areas.map(area => area.name).join(', ');
  $('map-area-title').textContent = deck.areas.length === mapData.areas.length ? activeCity.allAreasTitle
    : deck.areas.length <= 2 ? deck.areas.map(area => area.name).join(' + ') : `${deck.areas.length} ${activeCity.name} areas`;
  $('deck-detail').textContent = `${streets.length} selected / ${mapData.streets.length} total study streets · OpenStreetMap snapshot ${mapData.snapshot.slice(0, 10)} · no account needed`;
  if (persist) {
    try {
      localStorage.setItem(activeCity.areasKey, JSON.stringify(ids));
      areaPreferenceWarning = '';
    } catch {
      areaPreferenceWarning = 'Area selection could not be saved; it applies to this visit only.';
    }
  }
  areaStatus(`Studying ${streets.length} streets in ${names}. ${areaPreferenceWarning}`.trim(), !!areaPreferenceWarning);
  $('review-feedback').textContent = '';
  nextStreet();
}

$('area-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!ready) return;
  const ids = [...document.querySelectorAll('[name="study-area"]:checked')].map(input => input.value);
  if (!ids.length) {
    areaStatus('Choose at least one area. Your current study session has not changed.', true);
    document.querySelector('[name="study-area"]').focus({ preventScroll: true });
    return;
  }
  applyStudyAreas(ids, true);
});

$('select-all-areas').addEventListener('click', () => {
  for (const input of document.querySelectorAll('[name="study-area"]')) input.checked = true;
});

function geographicView(bounds, minimumWidth = WIDTH / 64) {
  const [left, top] = project([bounds.west, bounds.north]);
  const [right, bottom] = project([bounds.east, bounds.south]);
  const w = Math.min(WIDTH, Math.max(minimumWidth, (right - left) * 1.1, (bottom - top) * WIDTH / HEIGHT * 1.1));
  const h = w * HEIGHT / WIDTH;
  return { x: (left + right - w) / 2, y: (top + bottom - h) / 2, w, h };
}

function questionView() {
  if (!current) return { ...homeView };
  const bounds = { west: Infinity, east: -Infinity, south: Infinity, north: -Infinity };
  for (const line of current.lines) for (const [lon, lat] of line) {
    bounds.west = Math.min(bounds.west, lon);
    bounds.east = Math.max(bounds.east, lon);
    bounds.south = Math.min(bounds.south, lat);
    bounds.north = Math.max(bounds.north, lat);
  }
  // Keep geographic context around short roads without shrinking a citywide
  // street into an unreadable highlight. Reset still fits all selected areas.
  return geographicView({ west: bounds.west - 0.0012, east: bounds.east + 0.0012,
    south: bounds.south - 0.0008, north: bounds.north + 0.0008 }, Math.min(homeView.w, minimumQuestionWidth));
}

function loadLabelPreference() {
  $('show-other-names').checked = false;
  try {
    $('show-other-names').checked = localStorage.getItem(activeCity.labelsKey) === 'true';
  } catch {
    $('label-setting-status').textContent = 'Label preference applies to this visit only.';
  }
}

$('show-other-names').addEventListener('change', () => {
  if (!ready) return;
  renderLabels();
  try {
    localStorage.setItem(activeCity.labelsKey, String($('show-other-names').checked));
    $('label-setting-status').textContent = '';
  } catch {
    $('label-setting-status').textContent = 'Could not save this preference; it applies to this visit only.';
  }
});

function renderLabels() {
  const show = $('show-other-names').checked;
  $('label-badge').textContent = show ? (current && !revealed ? 'OTHER NAMES SHOWN' : 'STREET NAMES SHOWN') : 'NAMES HIDDEN';
  $('map').setAttribute('aria-label', `${activeCity.name} street map${show ? ' with neighboring street names' : ' with street names hidden'}.${current ? ` The street to recall is highlighted in orange${revealed ? '.' : ', with its name hidden.'}` : ' No street is selected.'}`);
  mapRenderer?.setLabels(show, current && !revealed ? current.id : null);
}

function storageWarning(message) {
  $('storage-warning').textContent = message;
  $('storage-warning').hidden = false;
  $('save-status').textContent = 'Session only · progress is not being saved';
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(activeCity.progressKey);
    if (raw === null) return;
    const saved = JSON.parse(raw);
    if (saved?.version !== 1 || !saved.cards || typeof saved.cards !== 'object'
      || Array.isArray(saved.cards) || !Object.values(saved.cards).every(validCard)) {
      throw new Error('Unrecognized progress');
    }
    cards = saved.cards;
  } catch {
    canSave = false;
    storageWarning('Saved progress could not be read. Existing data has been left untouched. You can study this session, but these reviews will not be saved. Check browser storage permissions or clear this site’s data to start over.');
  }
}

function saveProgress() {
  if (!canSave) return;
  try {
    localStorage.setItem(activeCity.progressKey, JSON.stringify({ version: 1, cards }));
  } catch {
    canSave = false;
    storageWarning('Your browser could not save this review. You can keep studying this session, but new progress will be lost when you leave. Check browser storage permissions and available space.');
  }
}

function renderMap(data) {
  mapRenderer = new MapRenderer($('map-canvas'), $('map'), data);
  project = mapRenderer.project;
  minimumQuestionWidth = mapRenderer.unitsPerKm;
  for (const id of ['zoom-in', 'zoom-out', 'reset-map']) $(id).disabled = false;
}

function setView(next) {
  next.x = Math.max(0, Math.min(WIDTH - next.w, next.x));
  next.y = Math.max(0, Math.min(HEIGHT - next.h, next.y));
  view = next;
  mapRenderer?.setView(view);
}

function zoom(factor) {
  const width = Math.max(WIDTH / 64, Math.min(WIDTH, view.w * factor));
  const height = width * HEIGHT / WIDTH;
  setView({ x: view.x + (view.w - width) / 2, y: view.y + (view.h - height) / 2, w: width, h: height });
}

$('zoom-in').addEventListener('click', () => zoom(1 / 1.5));
$('zoom-out').addEventListener('click', () => zoom(1.5));
$('reset-map').addEventListener('click', () => setView({ ...homeView }));
let drag = null;
$('map').addEventListener('pointerdown', event => {
  if (!ready || !event.isPrimary || event.button !== 0) return;
  const scale = mapRenderer?.getScale();
  if (!scale) return;
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, view: { ...view }, scale };
  $('map').setPointerCapture(event.pointerId);
});
$('map').addEventListener('pointermove', event => {
  if (!ready || !drag || drag.id !== event.pointerId) return;
  setView({ ...drag.view, x: drag.view.x - (event.clientX - drag.x) / drag.scale, y: drag.view.y - (event.clientY - drag.y) / drag.scale });
});
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) $('map').addEventListener(event, () => { drag = null; });

function refreshCounts() {
  const now = Date.now();
  const introduced = streets.filter(street => Object.hasOwn(cards, street.id));
  $('new-count').textContent = streets.length - introduced.length;
  $('due-count').textContent = introduced.filter(street => cards[street.id].due <= now).length;
  $('learned-count').textContent = introduced.length;
  $('session-count').textContent = sessionReviews;
}

function nextStreet() {
  const now = Date.now();
  current = selectStreet(streets, cards, now);
  revealed = false;
  $('answer-panel').hidden = true;
  $('answer').textContent = '';
  $('ratings').replaceChildren();
  $('question-panel').hidden = !current;
  $('complete-panel').hidden = !!current;
  $('guess').value = '';
  $('guess').disabled = !current;
  $('reveal').disabled = !current;
  $('reveal').textContent = 'Reveal street name';
  setView(questionView());
  mapRenderer.setStreet(current);
  renderLabels();
  if (!current) {
    $('complete-title').textContent = streets.length ? 'You’re all caught up.' : 'No streets to review.';
    const nextDue = streets.length ? Math.min(...streets.map(street => cards[street.id].due)) : null;
    $('next-review').textContent = nextDue === null ? 'Choose another study area to find more streets.'
      : `All ${streets.length} selected streets have been introduced. Next review: ${new Date(nextDue).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}. This page will check again automatically.`;
  }
  refreshCounts();
}

function reveal() {
  if (!ready || !current || revealed) return;
  revealed = true;
  $('question-panel').hidden = true;
  $('answer-panel').hidden = false;
  $('answer').textContent = current.name;
  renderLabels();
  for (const [index, rating] of RATINGS.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    const label = rating[0].toUpperCase() + rating.slice(1);
    const interval = intervalLabel(schedule(cards[current.id], rating).interval);
    button.textContent = `${index + 1} · ${label}`;
    const caption = document.createElement('small');
    caption.textContent = interval;
    button.append(caption);
    button.addEventListener('click', () => rate(rating));
    $('ratings').append(button);
  }
  $('ratings').firstElementChild.focus({ preventScroll: true });
}

function rate(rating) {
  if (!ready || !current || !revealed) return;
  const reviewed = current;
  cards[reviewed.id] = schedule(cards[reviewed.id], rating);
  sessionReviews += 1;
  saveProgress();
  $('review-feedback').textContent = `${reviewed.name} · ${rating} · next in ${intervalLabel(cards[reviewed.id].interval)}.`;
  nextStreet();
  (current ? $('reveal') : $('check-due')).focus({ preventScroll: true });
}

$('reveal').addEventListener('click', reveal);
$('check-due').addEventListener('click', () => { nextStreet(); if (current) $('reveal').focus({ preventScroll: true }); });
document.addEventListener('keydown', event => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
  if (event.key === 'Enter' && !revealed && (event.target === $('guess') || event.target === document.body)) {
    event.preventDefault();
    reveal();
  } else if (revealed && /^[1-4]$/.test(event.key)) {
    event.preventDefault();
    rate(RATINGS[Number(event.key) - 1]);
  }
});

async function loadCity(cityId) {
  if (!Object.hasOwn(CITIES, cityId)) {
    $('city-select').value = activeCityId;
    $('city-status').textContent = `“${cityId}” isn't available in this version of the app. Reload the page to update.`;
    return;
  }
  if (ready) {
    citySessions.set(activeCityId, {
      cards, canSave, sessionReviews, areaIds: selectedAreaIds,
      showNames: $('show-other-names').checked,
      warning: $('storage-warning').hidden ? '' : $('storage-warning').textContent,
      labelWarning: $('label-setting-status').textContent,
      areaWarning: areaPreferenceWarning,
    });
  }
  cityLoadController?.abort();
  const controller = new AbortController();
  cityLoadController = controller;
  const city = CITIES[cityId];
  ready = false;
  current = null;
  revealed = false;
  mapRenderer?.destroy();
  mapRenderer = null;
  mapData = null;
  drag = null;
  $('map').replaceChildren();
  $('map').setAttribute('aria-label', `Loading ${city.name} street map`);
  $('area-options').disabled = true;
  for (const id of ['reveal', 'guess', 'show-other-names', 'check-due', 'zoom-in', 'zoom-out', 'reset-map']) $(id).disabled = true;
  $('answer-panel').hidden = true;
  $('answer').textContent = '';
  $('guess').value = '';
  $('ratings').replaceChildren();
  $('complete-panel').hidden = true;
  $('question-panel').hidden = false;
  $('reveal').textContent = `Loading ${city.name}…`;
  for (const id of ['new-count', 'due-count', 'learned-count', 'session-count']) $(id).textContent = '—';
  $('label-badge').textContent = 'LOADING';
  $('area-description').textContent = city.areaDescription;
  $('storage-warning').hidden = true;
  $('review-feedback').textContent = '';
  $('map-area-title').textContent = `Loading ${city.name}…`;
  $('area-choices').textContent = `Loading ${city.name} study areas…`;
  areaStatus('');
  $('city-status').textContent = '';
  try {
    const response = await fetch(new URL(`./data/${cityId}.json`, import.meta.url), { signal: controller.signal });
    if (!response.ok) throw new Error(`Map request failed (${response.status})`);
    const data = await response.json();
    if (controller.signal.aborted) return;
    activeCity = city;
    activeCityId = cityId;
    mapData = data;
    const previous = citySessions.get(cityId);
    cards = previous?.cards ?? {};
    canSave = previous?.canSave ?? true;
    sessionReviews = previous?.sessionReviews ?? 0;
    areaPreferenceWarning = previous?.areaWarning ?? '';
    $('storage-warning').hidden = true;
    $('storage-warning').textContent = '';
    $('save-status').textContent = 'Progress saved in this browser';
    $('label-setting-status').textContent = previous?.labelWarning ?? '';
    if (previous) {
      $('show-other-names').checked = previous.showNames;
      if (previous.warning) storageWarning(previous.warning);
    } else {
      loadProgress();
      loadLabelPreference();
    }
    document.title = `${city.name} · Street Recall`;
    $('area-description').textContent = city.areaDescription;
    $('boundary-credit').hidden = !city.credit;
    if (city.credit) {
      $('boundary-credit-label').textContent = city.credit.label;
      $('boundary-credit-link').textContent = city.credit.text;
      $('boundary-credit-link').href = city.credit.url;
    }
    renderMap(data);
    createAreaChoices();
    applyStudyAreas(previous?.areaIds ?? loadAreaSelection());
    $('show-other-names').disabled = false;
    $('check-due').disabled = false;
    ready = true;
    try {
      localStorage.setItem(CITY_KEY, cityId);
    } catch {
      $('city-status').textContent = 'City choice applies to this visit only.';
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    ready = false;
    $('area-options').disabled = true;
    for (const id of ['reveal', 'guess', 'show-other-names', 'check-due', 'zoom-in', 'zoom-out', 'reset-map']) $(id).disabled = true;
    mapRenderer?.destroy();
    mapRenderer = null;
    $('map').replaceChildren();
    $('map').setAttribute('aria-label', `${city.name} map unavailable`);
    $('map-area-title').textContent = `${city.name} map unavailable`;
    $('label-badge').textContent = 'MAP UNAVAILABLE';
    $('reveal').textContent = 'Map unavailable';
    $('review-feedback').textContent = `${city.label} could not load. Reload the page or select another city. ${error.message}`;
    $('save-status').textContent = 'No reviews recorded for this city';
  }
}

$('city-select').addEventListener('change', () => loadCity($('city-select').value));

let initialCity = 'pendleton';
try {
  const savedCity = localStorage.getItem(CITY_KEY);
  if (Object.hasOwn(CITIES, savedCity)) initialCity = savedCity;
} catch {
  // Per-city storage handling below reports unavailable progress storage.
}
$('city-select').value = initialCity;
loadCity(initialCity);
setInterval(() => {
  if (!ready) return;
  if (!current) nextStreet();
  else refreshCounts();
}, 15_000);
