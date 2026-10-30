const DIRECTION = /^(Northeast|Northwest|Southeast|Southwest|North|South|East|West)\s+/;
const TOUCH_METERS = 25;

const prefixOf = name => DIRECTION.exec(name)?.[1] ?? null;

// Names that can only be the same road: equal once a leading direction is
// dropped and the words (including the halves of a hyphenated name) are put in
// a fixed order ("Washington-Oregon Highway" is the other direction of
// "Oregon-Washington Highway").
const variantKey = name => name.replace(DIRECTION, '').toLowerCase()
  .split(/[\s-]+/).filter(Boolean).sort().join(' ');

function metersBetween(a, b) {
  return 111_200 * Math.hypot((a[0] - b[0]) * Math.cos((a[1] + b[1]) * Math.PI / 360), a[1] - b[1]);
}

// Whether an end of one street lies on the other street (or its end), i.e. the
// two names are consecutive stretches of one road rather than separate streets.
function touches(linesA, linesB) {
  const near = (from, to) => {
    for (const line of from) for (const end of [line[0], line[line.length - 1]]) {
      for (const other of to) for (const point of other) {
        if (metersBetween(end, point) <= TOUCH_METERS) return true;
      }
    }
    return false;
  };
  return near(linesA, linesB) || near(linesB, linesA);
}

function addMeters(target, source) {
  for (const [kind, meters] of Object.entries(source)) target[kind] = (target[kind] ?? 0) + meters;
}

// Merges names that are the same road under two spellings: a name and the same
// name with a direction prefix, or the same hyphenated name reversed, whose
// geometry touches. Different direction prefixes ("Southeast X", "Southwest X")
// are different streets and are never merged, however they touch.
//
// streetsByName: Map(name -> Map(areaId -> lines)); metersByName: Map(name -> {highway: meters}).
// Returns the merged maps and the list of merges for the refresh log.
export function mergeVariantStreets(streetsByName, metersByName) {
  const groups = new Map();
  for (const name of [...streetsByName.keys()].sort()) {
    const key = variantKey(name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(name);
  }
  const linesOf = name => [...streetsByName.get(name).values()].flat();
  const canonicalOf = new Map();
  const merges = [];
  for (const names of groups.values()) {
    if (names.length < 2) continue;
    // Edges join names that are provably one road. A name touching two
    // differently prefixed names is ambiguous (which quadrant is it?), so it
    // joins neither; the result does not depend on name order.
    const neighbors = new Map(names.map(name => [name, []]));
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        const [a, b] = [names[i], names[j]];
        if (prefixOf(a) && prefixOf(b) && prefixOf(a) !== prefixOf(b)) continue;
        if (touches(linesOf(a), linesOf(b))) { neighbors.get(a).push(b); neighbors.get(b).push(a); }
      }
    }
    const ambiguous = new Set(names.filter(name => {
      const around = new Set([prefixOf(name), ...neighbors.get(name).map(prefixOf)].filter(Boolean));
      return around.size > 1;
    }));
    const parent = new Map(names.map(name => [name, name]));
    const find = name => (parent.get(name) === name ? name : find(parent.get(name)));
    for (const [name, others] of neighbors) {
      if (ambiguous.has(name)) continue;
      for (const other of others) if (!ambiguous.has(other)) parent.set(find(name), find(other));
    }
    const members = new Map();
    for (const name of names) {
      const root = find(name);
      if (!members.has(root)) members.set(root, []);
      members.get(root).push(name);
    }
    for (const variants of members.values()) {
      if (variants.length < 2) continue;
      // The longest mapped road names the street, so a short stub never renames
      // a street or drops its direction prefix.
      const mapped = name => linesOf(name).reduce((sum, line) =>
        sum + line.slice(1).reduce((inner, point, i) => inner + metersBetween(line[i], point), 0), 0);
      const canonical = [...variants].sort((a, b) => mapped(b) - mapped(a) || a.localeCompare(b))[0];
      for (const name of variants) canonicalOf.set(name, canonical);
      merges.push({ canonical, variants: variants.filter(name => name !== canonical) });
    }
  }
  const mergedStreets = new Map();
  const mergedMeters = new Map();
  for (const [name, parts] of streetsByName) {
    const canonical = canonicalOf.get(name) ?? name;
    if (!mergedStreets.has(canonical)) mergedStreets.set(canonical, new Map());
    const target = mergedStreets.get(canonical);
    for (const [areaId, lines] of parts) {
      if (!target.has(areaId)) target.set(areaId, []);
      target.get(areaId).push(...lines);
    }
    if (metersByName.has(name)) {
      if (!mergedMeters.has(canonical)) mergedMeters.set(canonical, {});
      addMeters(mergedMeters.get(canonical), metersByName.get(name));
    }
  }
  return { streetsByName: mergedStreets, metersByName: mergedMeters, merges };
}
