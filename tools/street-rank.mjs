// Importance of a road, most to least: its OSM road class, then how much of it
// is mapped. This one ranking is the order new cards are introduced in.
const CLASS_RANK = new Map(['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street']
  .map((roadClass, rank) => [roadClass, rank]));

export const IMPORTANCE_POLICY = {
  description: 'Roads are ranked from most to least important: primary, then secondary, tertiary, unclassified, and residential or living-street roads; within a class, longer mapped roads rank higher, and equal lengths are ordered by name. The rank is the card order.',
  rankedBy: ['road class (primary, secondary, tertiary, unclassified, residential/living street)', 'total mapped length, longest first', 'name'],
};

function lengthMeters(lines) {
  let meters = 0;
  for (const line of lines) {
    for (let i = 1; i < line.length; i += 1) {
      const [lon1, lat1] = line[i - 1];
      const [lon2, lat2] = line[i];
      meters += 111_200 * Math.hypot((lon2 - lon1) * Math.cos((lat1 + lat2) * Math.PI / 360), lat2 - lat1);
    }
  }
  return meters;
}

// Returns the streets ordered most to least important, each with `priority` set
// to its rank (0 = most important). Input objects are not modified.
export function rankStreetsByImportance(streets) {
  const scored = streets.map(street => {
    const rank = CLASS_RANK.get(street.roadClass);
    if (rank === undefined) throw new Error(`Unknown road class for ${street.name}: ${street.roadClass}`);
    return { street, rank, meters: lengthMeters(street.lines) };
  });
  scored.sort((a, b) => a.rank - b.rank || b.meters - a.meters || a.street.name.localeCompare(b.street.name, 'en'));
  return scored.map(({ street }, priority) => ({ ...street, priority }));
}
