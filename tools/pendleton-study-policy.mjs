const MAJOR_CLASSES = ['primary', 'secondary', 'tertiary'];
const CENTRAL_AREAS = ['south', 'southwest', 'north', 'east'];

// Order Pendleton introductions by major throughways and important areas first:
// primary, secondary, and tertiary corridors lead (Downtown first, then central
// neighborhoods, then West & airport), followed by Downtown and neighborhood
// throughways/streets, and finally outlying rural/airport unclassified roads.
export function classifyPendletonStreet(name, metersByClass, areaIds) {
  const areaSet = new Set(areaIds);
  if (areaSet.size === 0) return null;
  const throughway = areaSet.size > 1;
  const roadClass = MAJOR_CLASSES.find(kind => (metersByClass[kind] ?? 0) >= 90)
    ?? ((metersByClass.tertiary ?? 0) > 0 && throughway ? 'tertiary' : null)
    ?? (areaSet.has('downtown') || (metersByClass.residential ?? 0) >= 90 || (metersByClass.living_street ?? 0) >= 90
      ? 'residential'
      : (metersByClass.unclassified ?? 0) >= 90 ? 'unclassified' : null);
  if (!roadClass) return null;

  const areaTier = areaSet.has('downtown') ? 0
    : CENTRAL_AREAS.some(id => areaSet.has(id)) ? 1
    : 2;

  const priority = roadClass === 'primary' ? areaTier
    : roadClass === 'secondary' ? 3 + areaTier
    : roadClass === 'tertiary' ? 6 + areaTier
    : roadClass === 'residential'
      ? (areaTier === 0 ? (throughway ? 9 : 10)
        : areaTier === 1 ? (throughway ? 11 : 12)
        : 13)
      : (areaTier <= 1 ? (throughway ? 14 : 15) : 16);

  return { roadClass, areaTier, throughway, priority };
}


const ROAD_CLASS_RANK = {
  primary: 0, primary_link: 0,
  secondary: 1, secondary_link: 1,
  tertiary: 2, tertiary_link: 2,
  unclassified: 3, residential: 3, living_street: 3,
};

function pointKey([lon, lat]) {
  return `${lon.toFixed(7)},${lat.toFixed(7)}`;
}

function segmentKey(a, b) {
  const first = pointKey(a);
  const second = pointKey(b);
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}

function lengthMeters(lines) {
  const radians = Math.PI / 180;
  let meters = 0;
  for (const line of lines) {
    for (let i = 1; i < line.length; i += 1) {
      const [lon1, lat1] = line[i - 1];
      const [lon2, lat2] = line[i];
      const dLat = (lat2 - lat1) * radians;
      const dLon = (lon2 - lon1) * radians;
      const h = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(dLon / 2) ** 2;
      meters += 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
    }
  }
  return meters;
}

function bearing(a, b) {
  const dx = (b[0] - a[0]) * Math.cos((a[1] + b[1]) * Math.PI / 360);
  const dy = b[1] - a[1];
  return Math.atan2(dy, dx) * 180 / Math.PI;
}

function angleDifference(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

export function connectPolylines(lines) {
  const edges = [];
  const nodes = new Map();
  function node(key) {
    if (!nodes.has(key)) nodes.set(key, []);
    return nodes.get(key);
  }
  for (const line of lines) {
    if (line.length < 2) continue;
    const index = edges.length;
    const start = pointKey(line[0]);
    const end = pointKey(line[line.length - 1]);
    edges.push({ points: line.map(point => [...point]), start, end });
    node(start).push(index);
    node(end).push(index);
  }
  const used = new Uint8Array(edges.length);
  const chains = [];
  function walk(first, from) {
    const points = [];
    let index = first;
    let key = from;
    while (!used[index]) {
      used[index] = 1;
      const edge = edges[index];
      const forward = edge.start === key;
      for (let i = points.length ? 1 : 0; i < edge.points.length; i += 1) {
        points.push(edge.points[forward ? i : edge.points.length - 1 - i]);
      }
      key = forward ? edge.end : edge.start;
      const adjacent = nodes.get(key);
      if (adjacent.length !== 2) break;
      const next = adjacent[0] === index ? adjacent[1] : adjacent[0];
      if (used[next]) break;
      index = next;
    }
    chains.push(points);
  }
  for (const [key, adjacent] of nodes) {
    if (adjacent.length !== 2) {
      for (const index of adjacent) if (!used[index]) walk(index, key);
    }
  }
  for (let i = 0; i < edges.length; i += 1) {
    if (!used[i]) walk(i, edges[i].start);
  }
  return chains;
}

function connectedComponents(lines) {
  const count = lines.length;
  const parent = Array.from({ length: count }, (_, index) => index);
  const find = x => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const byPoint = new Map();
  for (let i = 0; i < count; i += 1) {
    for (const point of lines[i]) {
      const key = pointKey(point);
      if (byPoint.has(key)) parent[find(i)] = find(byPoint.get(key));
      else byPoint.set(key, i);
    }
  }
  const groups = new Map();
  for (let i = 0; i < count; i += 1) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(lines[i]);
  }
  return [...groups.values()];
}

function componentEndpointBearings(component) {
  const degree = new Map();
  const outward = new Map();
  for (const line of component) {
    for (let i = 1; i < line.length; i += 1) {
      const a = line[i - 1];
      const b = line[i];
      const ka = pointKey(a);
      const kb = pointKey(b);
      degree.set(ka, (degree.get(ka) ?? 0) + 1);
      degree.set(kb, (degree.get(kb) ?? 0) + 1);
      if (!outward.has(ka)) outward.set(ka, []);
      if (!outward.has(kb)) outward.set(kb, []);
      outward.get(ka).push(bearing(b, a));
      outward.get(kb).push(bearing(a, b));
    }
  }
  return { degree, outward };
}

function shortestRoadBridge(compA, compB, roadGraph, pointCoords, maxMeters = 1500) {
  const startKeys = new Set(compA.flat().map(pointKey));
  const targetKeys = new Set(compB.flat().map(pointKey));
  const distance = new Map();
  const previous = new Map();
  const queue = [];
  for (const key of startKeys) {
    if (!roadGraph.has(key)) continue;
    distance.set(key, 0);
    queue.push([0, key]);
  }
  while (queue.length > 0) {
    queue.sort((a, b) => a[0] - b[0]);
    const [dist, current] = queue.shift();
    if (dist > (distance.get(current) ?? Infinity)) continue;
    if (targetKeys.has(current)) {
      const steps = [];
      let cursor = current;
      while (previous.has(cursor)) {
        const step = previous.get(cursor);
        steps.unshift(step);
        cursor = step.from;
      }
      return { dist, startPoint: pointCoords.get(cursor), endPoint: pointCoords.get(current), steps };
    }
    if (dist > maxMeters) continue;
    for (const edge of roadGraph.get(current) ?? []) {
      const nextDist = dist + edge.dist;
      if (nextDist < (distance.get(edge.to) ?? Infinity)) {
        distance.set(edge.to, nextDist);
        previous.set(edge.to, { from: current, ...edge });
        queue.push([nextDist, edge.to]);
      }
    }
  }
  return null;
}

// Reconnects Pendleton streets split across sub-90m area corners, unnamed link
// ways, shared highway concurrencies (such as Oregon-Washington Highway along
// Southeast Court Avenue, Airport Road along Northwest A Avenue, and Rieth Road
// along Main Street), and short cross-street intersection doglegs.
export function connectPendletonStreets(streets, roads, areas, clipLine) {
  const segmentOwners = new Map();
  for (const street of streets) {
    for (const lines of Object.values(street.parts)) {
      for (const line of lines) {
        for (let i = 1; i < line.length; i += 1) {
          const key = segmentKey(line[i - 1], line[i]);
          if (!segmentOwners.has(key)) segmentOwners.set(key, new Set());
          segmentOwners.get(key).add(street.name);
        }
      }
    }
  }

  const linesByStreet = new Map(streets.map(street => [street.name, []]));
  const unownedEligible = [];
  const roadGraph = new Map();
  const pointCoords = new Map();

  for (const { kind, lines } of roads) {
    if (!(kind in ROAD_CLASS_RANK)) continue;
    for (const line of lines) {
      const owners = new Set();
      for (const area of areas) {
        for (const clipped of clipLine(line, area.bounds)) {
          for (let i = 1; i < clipped.length; i += 1) {
            const a = clipped[i - 1];
            const b = clipped[i];
            const ka = pointKey(a);
            const kb = pointKey(b);
            pointCoords.set(ka, a);
            pointCoords.set(kb, b);
            const dist = lengthMeters([[a, b]]);
            if (!roadGraph.has(ka)) roadGraph.set(ka, []);
            if (!roadGraph.has(kb)) roadGraph.set(kb, []);
            roadGraph.get(ka).push({ to: kb, dist, kind, seg: [a, b] });
            roadGraph.get(kb).push({ to: ka, dist, kind, seg: [b, a] });
            for (const owner of segmentOwners.get(segmentKey(a, b)) ?? []) {
              owners.add(owner);
            }
          }
        }
      }
      if (owners.size === 1) {
        linesByStreet.get([...owners][0]).push(line.map(point => [...point]));
      } else if (owners.size === 0 && !kind.endsWith('_link')) {
        unownedEligible.push({ kind, line: line.map(point => [...point]), used: false });
      }
    }
  }

  for (const street of streets) {
    if (linesByStreet.get(street.name).length === 0) {
      linesByStreet.set(street.name, street.lines.map(line => line.map(point => [...point])));
    }
  }

  let attached = true;
  while (attached) {
    attached = false;
    const endpoints = new Map();
    for (const [streetName, lines] of linesByStreet) {
      const chains = connectPolylines(lines);
      const { degree, outward } = componentEndpointBearings(chains);
      for (const [key, deg] of degree) {
        if (deg !== 1) continue;
        if (!endpoints.has(key)) endpoints.set(key, []);
        for (const dir of outward.get(key) ?? []) {
          endpoints.get(key).push({ street: streetName, dir });
        }
      }
    }
    for (const item of unownedEligible) {
      if (item.used) continue;
      const start = item.line[0];
      const end = item.line[item.line.length - 1];
      const startDir = bearing(item.line[0], item.line[1]);
      const endDir = bearing(item.line[item.line.length - 1], item.line[item.line.length - 2]);
      const candidates = [
        ...(endpoints.get(pointKey(start)) ?? [])
          .map(entry => ({ street: entry.street, diff: angleDifference(entry.dir, startDir) }))
          .filter(entry => entry.diff <= 20),
        ...(endpoints.get(pointKey(end)) ?? [])
          .map(entry => ({ street: entry.street, diff: angleDifference(entry.dir, endDir) }))
          .filter(entry => entry.diff <= 20),
      ].sort((a, b) => a.diff - b.diff);
      if (candidates.length > 0 && (candidates.length === 1 || candidates[0].diff + 5 < candidates[1].diff)) {
        linesByStreet.get(candidates[0].street).push(item.line.map(point => [...point]));
        item.used = true;
        attached = true;
      }
    }
  }

  return streets.map(street => {
    const baseLines = linesByStreet.get(street.name);
    const comps = connectedComponents(baseLines);
    if (comps.length > 1) {
      const meta = comps.map(componentEndpointBearings);
      const streetRank = ROAD_CLASS_RANK[street.roadClass] ?? 3;
      const bridges = [];
      for (let i = 0; i < comps.length; i += 1) {
        for (let j = i + 1; j < comps.length; j += 1) {
          const bridge = shortestRoadBridge(comps[i], comps[j], roadGraph, pointCoords, 1500);
          if (!bridge || bridge.dist === 0) continue;
          const crow = lengthMeters([[bridge.startPoint, bridge.endPoint]]);
          if (crow / bridge.dist < 0.90) continue;
          const startKey = pointKey(bridge.startPoint);
          const endKey = pointKey(bridge.endPoint);
          if (meta[i].degree.get(startKey) !== 1 || meta[j].degree.get(endKey) !== 1) continue;
          const dirFromStart = bearing(bridge.steps[0].seg[0], bridge.steps[0].seg[1]);
          const lastSeg = bridge.steps[bridge.steps.length - 1].seg;
          const dirFromEnd = bearing(lastSeg[1], lastSeg[0]);
          const minTurnStart = Math.min(...(meta[i].outward.get(startKey) ?? [180]).map(dir => angleDifference(dir, dirFromStart)));
          const minTurnEnd = Math.min(...(meta[j].outward.get(endKey) ?? [180]).map(dir => angleDifference(dir, dirFromEnd)));
          let maxInternalTurn = 0;
          for (let k = 1; k < bridge.steps.length; k += 1) {
            const prevDir = bearing(bridge.steps[k - 1].seg[0], bridge.steps[k - 1].seg[1]);
            const nextDir = bearing(bridge.steps[k].seg[0], bridge.steps[k].seg[1]);
            maxInternalTurn = Math.max(maxInternalTurn, angleDifference(prevDir, nextDir));
          }
          if (maxInternalTurn > 25 || minTurnStart > 95 || minTurnEnd > 95) continue;
          const isMajorCorridor = streetRank <= 2 && bridge.steps.every(step => (ROAD_CLASS_RANK[step.kind] ?? 3) <= 2);
          const isColinear = minTurnStart <= 30 && minTurnEnd <= 30;
          const isShortDogleg = bridge.dist <= 40;
          if (isMajorCorridor || isColinear || isShortDogleg) {
            bridges.push({ i, j, bridge });
          }
        }
      }
      bridges.sort((a, b) => a.bridge.dist - b.bridge.dist);
      const parent = Array.from({ length: comps.length }, (_, index) => index);
      const find = x => (parent[x] === x ? x : (parent[x] = find(parent[x])));
      for (const { i, j, bridge } of bridges) {
        if (find(i) === find(j)) continue;
        parent[find(i)] = find(j);
        baseLines.push([bridge.steps[0].seg[0], ...bridge.steps.map(step => step.seg[1])]);
      }
    }
    const connectedLines = connectPolylines(baseLines);
    const connectedParts = {};
    for (const area of areas) {
      if (!Object.hasOwn(street.parts, area.id)) continue;
      const clipped = connectedLines.flatMap(line => clipLine(line, area.bounds));
      connectedParts[area.id] = connectPolylines(clipped.length ? clipped : street.parts[area.id]);
    }
    return { ...street, lines: connectedLines, parts: connectedParts };
  });
}