import { createMapScene, labelPlacements } from './map-scene.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FONT = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const MINOR = /^(footway|path|steps|cycleway|pedestrian|track)$/;
const BACKGROUND = '#e9eddf';
const COLLISION_CELL = 64;

function lineBounds(points) {
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const [x, y] of points) {
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  return { left, right, top, bottom };
}

function intersects(bounds, view) {
  return bounds.left <= view.x + view.w && bounds.right >= view.x
    && bounds.top <= view.y + view.h && bounds.bottom >= view.y;
}

function paddedView(view, padding) {
  return { x: view.x - padding, y: view.y - padding,
    w: view.w + padding * 2, h: view.h + padding * 2 };
}

// Labels use a screen-space grid: the collision work depends on nearby labels,
// not on the total number already drawn elsewhere on the map.
class LabelGrid {
  constructor() {
    this.cells = new Map();
  }

  visit(box, callback) {
    for (let y = Math.floor(box.top / COLLISION_CELL); y <= Math.floor(box.bottom / COLLISION_CELL); y++) {
      for (let x = Math.floor(box.left / COLLISION_CELL); x <= Math.floor(box.right / COLLISION_CELL); x++) {
        if (callback(`${x},${y}`)) return true;
      }
    }
    return false;
  }

  overlaps(box) {
    return this.visit(box, key => this.cells.get(key)?.some(other =>
      box.left < other.right && box.right > other.left
      && box.top < other.bottom && box.bottom > other.top));
  }

  add(box) {
    this.visit(box, key => {
      let cell = this.cells.get(key);
      if (!cell) this.cells.set(key, cell = []);
      cell.push(box);
      return false;
    });
  }
}

export class MapRenderer {
  constructor(canvas, svg, data) {
    this.canvas = canvas;
    this.svg = svg;
    this.context = canvas.getContext('2d');
    this.backgroundCanvas = canvas.ownerDocument.createElement('canvas');
    this.backgroundContext = this.backgroundCanvas.getContext('2d');
    this.background = null;
    this.scene = createMapScene(data);
    this.project = this.scene.project;
    this.unitsPerKm = this.scene.unitsPerKm;
    this.view = { x: 0, y: 0, w: 1000, h: 800 };
    this.showLabels = false;
    this.hiddenStreetId = null;
    this.street = null;
    this.highlightData = '';
    this.highlightDirty = true;
    this.frame = null;
    this.destroyed = false;
    this.paths = new WeakMap();
    this.measurements = new Map();
    this.rivers = this.scene.rivers.map(points => ({ points, bounds: lineBounds(points) }));

    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = data.title || 'Street recall map';
    this.highlight = document.createElementNS(SVG_NS, 'path');
    this.highlight.setAttribute('fill', 'none');
    this.highlight.setAttribute('stroke', '#d76b39');
    this.highlight.setAttribute('stroke-width', '6');
    this.highlight.setAttribute('stroke-linecap', 'round');
    this.highlight.setAttribute('stroke-linejoin', 'round');
    this.highlight.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.replaceChildren(title, this.highlight);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    canvas.setAttribute('aria-hidden', 'true');

    // This is the only synchronous layout read. Pointer handlers and rendering
    // use these cached CSS dimensions, maintained by ResizeObserver thereafter.
    const initial = svg.getBoundingClientRect();
    this.cssWidth = initial.width;
    this.cssHeight = initial.height;
    this.observer = new ResizeObserver(entries => {
      if (this.destroyed) return;
      for (const entry of entries) {
        if (entry.target !== this.svg) continue;
        this.cssWidth = entry.contentRect.width;
        this.cssHeight = entry.contentRect.height;
      }
      this.queue();
    });
    this.observer.observe(svg);
    this.onPixelRatioChange = () => {
      if (this.destroyed) return;
      this.watchPixelRatio();
      this.queue();
    };
    this.onWindowResize = () => this.queue();
    window.addEventListener('resize', this.onWindowResize);
    this.watchPixelRatio();
    this.queue();
  }

  watchPixelRatio() {
    this.pixelRatioQuery?.removeEventListener('change', this.onPixelRatioChange);
    this.pixelRatioQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.pixelRatioQuery.addEventListener('change', this.onPixelRatioChange);
  }

  setView(view) {
    if (this.destroyed || (view.x === this.view.x && view.y === this.view.y
      && view.w === this.view.w && view.h === this.view.h)) return;
    this.view = { x: view.x, y: view.y, w: view.w, h: view.h };
    this.queue();
  }

  setLabels(show, hiddenStreetId) {
    if (this.destroyed) return;
    this.showLabels = Boolean(show);
    this.hiddenStreetId = hiddenStreetId ?? null;
    this.queue();
  }

  setStreet(street) {
    if (this.destroyed || street === this.street) return;
    this.street = street;
    // Keep the original, unsimplified geometry for the question highlight.
    // It is projected just once per card, never while panning or zooming.
    this.highlightData = street ? street.lines.map(line => line.map((point, index) => {
      const [x, y] = this.project(point);
      return `${index ? 'L' : 'M'}${x},${y}`;
    }).join(' ')).join(' ') : '';
    this.highlightDirty = true;
    this.queue();
  }

  getScale() {
    const scale = Math.min(this.cssWidth / this.view.w, this.cssHeight / this.view.h);
    return scale > 0 ? scale : 1;
  }

  queue() {
    if (this.destroyed || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (!this.destroyed) this.draw();
    });
  }

  pathFor(points) {
    let path = this.paths.get(points);
    if (!path) {
      path = new Path2D();
      if (points.length) {
        path.moveTo(points[0][0], points[0][1]);
        for (let i = 1; i < points.length; i++) path.lineTo(points[i][0], points[i][1]);
      }
      this.paths.set(points, path);
    }
    return path;
  }

  draw() {
    const { context, cssWidth: width, cssHeight: height, view } = this;
    // Apply the highlight and name mask in the same frame. The cached bitmap
    // contains roads only: a previous question's labels can never leak through.
    this.svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    if (this.highlightDirty) {
      this.highlight.setAttribute('d', this.highlightData);
      this.highlightDirty = false;
    }
    if (!width || !height) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.fillStyle = BACKGROUND;
    context.fillRect(0, 0, width, height);

    const scale = this.getScale();
    const offsetX = (width - view.w * scale) / 2 - view.x * scale;
    const offsetY = (height - view.h * scale) / 2 - view.y * scale;
    // Include the world visible in SVG's letterbox gutters, not just viewBox.
    const visible = { x: -offsetX / scale, y: -offsetY / scale,
      w: width / scale, h: height / scale };
    const background = this.backgroundFor(visible, scale, dpr);
    context.drawImage(this.backgroundCanvas, background.view.x * scale + offsetX,
      background.view.y * scale + offsetY, this.backgroundCanvas.width / dpr,
      this.backgroundCanvas.height / dpr);
    if (this.showLabels) this.drawLabels(visible, scale, offsetX, offsetY, dpr);
  }

  backgroundFor(visible, scale, dpr) {
    const cached = this.background;
    if (cached && cached.scale === scale && cached.dpr === dpr
      && cached.width === this.cssWidth && cached.height === this.cssHeight
      && visible.x >= cached.view.x && visible.y >= cached.view.y
      && visible.x + visible.w <= cached.view.x + cached.view.w
      && visible.y + visible.h <= cached.view.y + cached.view.h) return cached;

    // One bounded overscan bitmap avoids retracing roads on ordinary drags.
    // Zoom, resize, DPR changes, or leaving its extent rebuild it from the index.
    const width = Math.ceil(this.cssWidth * 1.5 * dpr);
    const height = Math.ceil(this.cssHeight * 1.5 * dpr);
    this.backgroundCanvas.width = width;
    this.backgroundCanvas.height = height;
    const view = { x: visible.x - visible.w / 4, y: visible.y - visible.h / 4,
      w: width / dpr / scale, h: height / dpr / scale };
    const context = this.backgroundContext;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = BACKGROUND;
    context.fillRect(0, 0, width, height);
    context.setTransform(dpr * scale, 0, 0, dpr * scale, -view.x * scale * dpr, -view.y * scale * dpr);
    this.paintRoads(context, view, scale);
    this.background = { view, scale, dpr, width: this.cssWidth, height: this.cssHeight };
    return this.background;
  }

  paintRoads(context, visible, scale) {
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.setLineDash([]);
    context.strokeStyle = '#b5d4d3';
    context.lineWidth = this.unitsPerKm * 0.04;
    const riverView = paddedView(visible, context.lineWidth / 2);
    for (const river of this.rivers) {
      if (intersects(river.bounds, riverView)) context.stroke(this.pathFor(river.points));
    }
    const roads = this.scene.queryRoads(paddedView(visible, 3 / scale), 0.6 / scale);
    for (const road of roads) {
      const minor = MINOR.test(road.kind);
      const roadWidth = minor ? 0.8 : road.kind === 'service' ? 1.7 : 3.5;
      const path = new Path2D();
      for (const line of road.lines) path.addPath(this.pathFor(line));
      context.setLineDash([]);
      if (!minor) {
        context.strokeStyle = '#c7cebf';
        context.lineWidth = (roadWidth + 1) / scale;
        context.stroke(path);
      }
      context.strokeStyle = minor ? '#c5cbb9' : '#fffdf5';
      context.lineWidth = roadWidth / scale;
      if (minor) context.setLineDash([3 / scale, 4 / scale]);
      context.stroke(path);
    }
    context.setLineDash([]);
  }

  drawLabels(visible, scale, offsetX, offsetY, dpr) {
    const context = this.context;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.font = FONT;
    context.textAlign = 'center';
    context.textBaseline = 'alphabetic';
    context.strokeStyle = '#fffdf5';
    context.fillStyle = '#3c544c';
    context.lineWidth = 3;
    context.lineJoin = 'round';
    const occupied = new LabelGrid();
    for (const label of this.scene.queryLabels(visible)) {
      if (label.id === this.hiddenStreetId) continue;
      let metrics = this.measurements.get(label.name);
      if (!metrics) {
        const measured = context.measureText(label.name);
        const ascent = measured.actualBoundingBoxAscent ?? 9;
        const descent = measured.actualBoundingBoxDescent ?? 3;
        metrics = { width: measured.width, height: ascent + descent, baseline: (ascent - descent) / 2 };
        this.measurements.set(label.name, metrics);
      }
      for (const placement of labelPlacements(label, visible, (metrics.width + 6) / scale)) {
        const x = placement.x * scale + offsetX;
        const y = placement.y * scale + offsetY;
        const cosine = Math.abs(Math.cos(placement.angle));
        const sine = Math.abs(Math.sin(placement.angle));
        const halfWidth = (cosine * (metrics.width + 3) + sine * (metrics.height + 3)) / 2;
        const halfHeight = (sine * (metrics.width + 3) + cosine * (metrics.height + 3)) / 2;
        const box = { left: x - halfWidth, right: x + halfWidth, top: y - halfHeight, bottom: y + halfHeight };
        if (box.left < 0 || box.right > this.cssWidth || box.top < 0 || box.bottom > this.cssHeight) continue;
        const collision = { left: box.left - 3, right: box.right + 3, top: box.top - 3, bottom: box.bottom + 3 };
        if (occupied.overlaps(collision)) continue;
        occupied.add(collision);
        context.save();
        context.translate(x, y);
        context.rotate(placement.angle);
        context.strokeText(label.name, 0, metrics.baseline);
        context.fillText(label.name, 0, metrics.baseline);
        context.restore();
        break;
      }
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.observer.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    this.pixelRatioQuery?.removeEventListener('change', this.onPixelRatioChange);
    this.context.setTransform(1, 0, 0, 1, 0, 0);
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.svg.replaceChildren();
    this.measurements.clear();
    this.paths = new WeakMap();
    this.background = null;
    this.backgroundCanvas.width = this.backgroundCanvas.height = 0;
  }
}
