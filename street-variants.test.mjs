import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mergeVariantStreets } from './tools/street-variants.mjs';

// One street per entry: name -> a single east-west line starting at `lon`, with a vertex
// every 0.001° (≈ 85 m) like a mapped road.
const line = (lon, length) => Array.from({ length: Math.round(length / 0.001) + 1 }, (_, i) => [lon + i * 0.001, 45]);
const streets = entries => new Map(entries.map(([name, lon, length = 0.005]) =>
  [name, new Map([['area', [line(lon, length)]]])]));
const merge = entries => mergeVariantStreets(streets(entries), new Map());

test('a plain name and the same name with a direction prefix join when their lines meet', () => {
  const { streetsByName, merges } = merge([['Pendleton Highway', 0], ['Southwest Pendleton Highway', 0.005, 0.003]]);
  assert.deepEqual([...streetsByName.keys()], ['Pendleton Highway']);
  assert.equal(streetsByName.get('Pendleton Highway').get('area').length, 2);
  assert.deepEqual(merges, [{ canonical: 'Pendleton Highway', variants: ['Southwest Pendleton Highway'] }]);
});

test('the longest mapped road keeps its name, so a stub never drops a direction prefix', () => {
  const { streetsByName } = merge([['Boones Ferry Road', 0, 0.001], ['Southwest Boones Ferry Road', 0.001, 0.02]]);
  assert.deepEqual([...streetsByName.keys()], ['Southwest Boones Ferry Road']);
});

test('names that are the same road in reverse order join; the same name far away does not', () => {
  const { streetsByName } = merge([['Oregon-Washington Highway', 0, 0.02], ['Washington-Oregon Highway', 0.005, 0.003]]);
  assert.deepEqual([...streetsByName.keys()], ['Oregon-Washington Highway']);
  const apart = merge([['Johns Lane', 0], ['Northwest Johns Lane', 1]]);
  assert.deepEqual([...apart.streetsByName.keys()].sort(), ['Johns Lane', 'Northwest Johns Lane']);
  assert.deepEqual(apart.merges, []);
});

test('different quadrants are never merged, however they touch', () => {
  const { streetsByName } = merge([['Southeast Court Avenue', 0], ['Southwest Court Avenue', 0.005]]);
  assert.deepEqual([...streetsByName.keys()], ['Southeast Court Avenue', 'Southwest Court Avenue']);
});

test('a plain name touching two different quadrants is ambiguous and joins neither', () => {
  const { streetsByName, merges } = merge([['Main Street', 0.005], ['Northeast Main Street', 0], ['Southeast Main Street', 0.01]]);
  assert.deepEqual([...streetsByName.keys()].sort(), ['Main Street', 'Northeast Main Street', 'Southeast Main Street']);
  assert.deepEqual(merges, []);
});

test('bundled datasets have one card per road for the split names that were reported', async () => {
  const pendleton = JSON.parse(await readFile(new URL('./data/pendleton.json', import.meta.url), 'utf8'));
  const names = new Set(pendleton.streets.map(street => street.name));
  assert.ok(names.has('Oregon-Washington Highway') && !names.has('Washington-Oregon Highway'));
  assert.ok(names.has('Pendleton-John Day Highway') && !names.has('Southwest Pendleton-John Day Highway'));
  assert.ok(names.has('Southeast 20th Street') && names.has('Southwest 20th Street'));

  const portland = JSON.parse(await readFile(new URL('./data/portland.json', import.meta.url), 'utf8'));
  const labels = new Set(portland.labels.map(label => label.name));
  assert.ok(labels.has('Southwest Boones Ferry Road') && !labels.has('Boones Ferry Road'));
  assert.ok(labels.has('Southeast 138th Place') && !labels.has('138th Place'));
});
