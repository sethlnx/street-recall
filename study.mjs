function corridorLength(lines) {
  let meters = 0;
  for (const line of lines) for (let i = 1; i < line.length; i++) {
    const [lon1, lat1] = line[i - 1];
    const [lon2, lat2] = line[i];
    meters += 111_200 * Math.hypot(
      (lon2 - lon1) * Math.cos((lat1 + lat2) * Math.PI / 360), lat2 - lat1,
    );
  }
  return meters;
}

export function buildStudyDeck(data, selectedIds) {
  if (!Array.isArray(selectedIds) || selectedIds.length === 0) {
    throw new RangeError('Select at least one study area');
  }

  const selected = new Set(selectedIds);
  if (selected.size !== selectedIds.length) {
    throw new RangeError('Study areas must not be repeated');
  }

  const areas = data.areas
    .filter(area => selected.has(area.id))
    .map(area => ({ ...area, bounds: { ...area.bounds } }));
  if (areas.length !== selected.size) {
    throw new RangeError('Unknown study area');
  }

  const bounds = {
    south: Math.min(...areas.map(area => area.bounds.south)),
    north: Math.max(...areas.map(area => area.bounds.north)),
    west: Math.min(...areas.map(area => area.bounds.west)),
    east: Math.max(...areas.map(area => area.bounds.east)),
  };
  const streets = [];
  for (const street of data.streets) {
    const selectedLines = [];
    for (const area of areas) {
      for (const line of street.parts[area.id] ?? []) {
        selectedLines.push(line);
      }
    }
    if (selectedLines.length > 0) {
      const sourceLines = street.lines?.length ? street.lines : selectedLines;
      const lines = sourceLines.map(line => line.map(point => [...point]));
      const card = { id: street.id, name: street.name, lines };
      if (street.priority !== undefined) {
        card.priority = street.priority;
        card.introductionLength = corridorLength(selectedLines);
      }
      streets.push(card);
    }
  }

  return { streets, bounds, areas };
}

// Prioritized decks introduce longer selected corridors within each tier.
// Equal-importance cards (and all unprioritized decks) remain shuffled. Due
// review precedence remains the scheduler's responsibility.
export function orderStudyStreets(streets, random = Math.random) {
  const ordered = [...streets];
  for (let i = ordered.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
  }
  if (ordered.some(street => street.priority !== undefined)) {
    ordered.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)
      || (b.introductionLength ?? 0) - (a.introductionLength ?? 0));
  }
  return ordered;
}
