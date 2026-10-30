const MAJOR_CLASSES = ['primary', 'secondary', 'tertiary'];
const NUMBERED_STREET = /\b\d+(?:st|nd|rd|th)?\b/i;

// Road importance comes from meaningful OSM road sections inside Portland,
// not a hand-maintained street-name allowlist or incidental short tag changes.
export function classifyPortlandStreet(name, metersByClass) {
  const roadClass = MAJOR_CLASSES.find(kind => (metersByClass[kind] ?? 0) >= 90);
  if (!roadClass) return null;
  const numbered = NUMBERED_STREET.test(name);
  if (numbered && roadClass === 'tertiary') return null;

  // Named arterials first; major numbered arterials remain in the curriculum.
  const priority = numbered
    ? (roadClass === 'primary' ? 2 : 4)
    : ({ primary: 0, secondary: 1, tertiary: 3 })[roadClass];
  return { roadClass, numbered, priority };
}
