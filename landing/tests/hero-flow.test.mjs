import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { makeRoute, pointOn, trailOpacity } from '../public/hero-flow.js';

test('light travels by distance through a tight bend without jumping at the join', () => {
  const route = makeRoute([0, 0], [[100, 0, 100, 100, 0, 100], [-100, 100, -100, 200, 0, 200]]);
  assert.deepEqual(pointOn(route, 0), { x: 0, y: 0 });
  assert.deepEqual(pointOn(route, route.length), { x: 0, y: 200 });
  let previous = pointOn(route, 0);
  for (let distance = 1; distance < route.length; distance++) {
    const point = pointOn(route, distance);
    const step = Math.hypot(point.x - previous.x, point.y - previous.y);
    assert.ok(step > .97 && step <= 1.001, `distance ${distance}: ${step}`);
    previous = point;
  }
  const middle = pointOn(route, route.length / 2);
  assert.ok(Math.abs(middle.x) < .01 && Math.abs(middle.y - 100) < .01);
});

test('parallel filaments stay separated along the curve and the light fades at every edge', () => {
  const route = makeRoute([0, 0], [[100, 0, 100, 100, 0, 100]]);
  for (const distance of [10, 50, 100, 150]) {
    const center = pointOn(route, distance);
    const lane = pointOn(route, distance, 8);
    assert.ok(Math.abs(Math.hypot(lane.x - center.x, lane.y - center.y) - 8) < .001);
  }
  assert.equal(trailOpacity(0, 100, 100, 600), 0);
  assert.equal(trailOpacity(600, 650, 100, 600), 0);
  assert.equal(trailOpacity(300, 300, 100, 600), 0);
  assert.equal(trailOpacity(200, 300, 100, 600), 0);
  assert.ok(trailOpacity(270, 300, 100, 600) > .7);
  for (let distance = 0; distance <= 600; distance++) {
    const alpha = trailOpacity(distance, 300, 100, 600);
    assert.ok(alpha >= 0 && alpha <= 1);
  }
});

function canvasContext(trace = []) {
  let path = [];
  const states = [];
  const stateKeys = ['globalAlpha', 'globalCompositeOperation', 'strokeStyle', 'fillStyle', 'lineWidth', 'lineCap', 'lineJoin'];
  const style = value => typeof value === 'string' ? value : value?.colors;
  const gradient = () => ({ colors: [], addColorStop(offset, color) { this.colors.push([offset, color]); } });
  const ctx = {
    globalAlpha: 1, globalCompositeOperation: 'source-over', strokeStyle: '#000', fillStyle: '#000', lineWidth: 1,
    lineCap: 'butt', lineJoin: 'miter', createRadialGradient: gradient, createLinearGradient: gradient,
    fillRect() {}, setTransform() {}, translate() {}, rotate() {}, scale() {},
    clearRect() { trace.length = 0; },
    save() { states.push(Object.fromEntries(stateKeys.map(key => [key, this[key]]))); },
    restore() { Object.assign(this, states.pop()); },
    beginPath() { path = []; },
    moveTo(...args) { path.push(['moveTo', ...args]); },
    lineTo(...args) { path.push(['lineTo', ...args]); },
    bezierCurveTo(...args) { path.push(['bezierCurveTo', ...args]); },
    arc(...args) { path.push(['arc', ...args]); },
    ellipse(...args) { path.push(['ellipse', ...args]); },
    closePath() { path.push(['closePath']); },
    stroke() {
      trace.push({ type: 'stroke', path: path.map(command => [...command]), style: style(this.strokeStyle),
        composite: this.globalCompositeOperation, alpha: this.globalAlpha, width: this.lineWidth });
    },
    fill() {
      trace.push({ type: 'fill', path: path.map(command => [...command]), style: style(this.fillStyle),
        composite: this.globalCompositeOperation, alpha: this.globalAlpha });
    },
    drawImage(image, ...args) {
      trace.push({ type: 'image', image: image.id, args, composite: this.globalCompositeOperation, alpha: this.globalAlpha });
    },
  };
  return ctx;
}

async function rendererHarness({ reduced = false } = {}) {
  const source = (await readFile(new URL('../public/hero-flow.js', import.meta.url), 'utf8')).replace(/^export /gm, '');
  const frames = new Map();
  const handlers = {};
  const trace = [];
  const media = { matches: reduced, addEventListener: (_name, fn) => { handlers.media = fn; } };
  const ctx = canvasContext(trace);
  const sceneStyleWrites = [];
  const sheen = { style: {} };
  const visual = { querySelector: () => sheen, style: {
    setProperty: (name, value) => sceneStyleWrites.push([name, value]),
    removeProperty: name => sceneStyleWrites.push([name, null]),
  } };
  const shell = {
    addEventListener: (name, fn) => { handlers[name] = fn; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 600 }),
  };
  const canvas = { dataset: {}, parentElement: visual, closest: () => shell,
    getContext: () => ctx, getBoundingClientRect: () => ({ width: 1000, height: 600 }) };
  let nextImage = 1;
  const document = { hidden: false, querySelector: () => canvas,
    createElement: () => { const spriteContext = canvasContext(); return { id: nextImage++, getContext: () => spriteContext }; },
    addEventListener: (name, fn) => { handlers[name] = fn; } };
  let nextFrame = 1;
  const sandbox = { document, window: {
    matchMedia: query => query.includes('prefers-reduced-motion') ? media : { matches: true },
    devicePixelRatio: 2, IntersectionObserver: true,
  },
    requestAnimationFrame: fn => { const id = nextFrame++; frames.set(id, fn); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    ResizeObserver: class { constructor(fn) { handlers.resize = fn; } observe() {} },
    IntersectionObserver: class { constructor(fn) { handlers.intersection = fn; } observe() {} },
  };
  vm.runInNewContext(source, sandbox);
  return { frames, handlers, media, canvas, document, trace, sheen, sceneStyleWrites,
    tick(time) {
      assert.equal(frames.size, 1, 'exactly one animation frame must be pending');
      const [id, fn] = [...frames][0];
      frames.delete(id);
      fn(time);
      assert.equal(frames.size, 1, 'painting must schedule exactly one successor');
      return structuredClone(trace);
    },
  };
}

test('reduced motion, hidden tabs and offscreen canvases stop work; repeated resumes schedule one frame', async () => {
  const { frames, handlers, media, canvas, document, tick } = await rendererHarness({ reduced: true });
  assert.equal(canvas.dataset.motion, 'paused');
  assert.equal(frames.size, 0);
  media.matches = false;
  handlers.media();
  handlers.media();
  assert.equal(frames.size, 1);
  document.hidden = true;
  handlers.visibilitychange();
  assert.equal(frames.size, 0);
  document.hidden = false;
  handlers.intersection([{ isIntersecting: false }]);
  handlers.visibilitychange();
  assert.equal(frames.size, 0);
  handlers.intersection([{ isIntersecting: true }]);
  assert.equal(frames.size, 1);
  for (const time of [16, 33, 50, 67]) {
    handlers.resize();
    handlers.visibilitychange();
    handlers.intersection([{ isIntersecting: true }]);
    tick(time);
  }
  media.matches = true;
  handlers.media();
  assert.equal(canvas.dataset.motion, 'paused');
  assert.equal(frames.size, 0);
});

test('hidden time does not advance the visible scene and resize never creates another animation loop', async () => {
  const { frames, handlers, canvas, document, tick, trace } = await rendererHarness();
  tick(1000);
  tick(1017);
  const moving = tick(1034);
  assert.ok(moving.length > 0, 'the scene must contain visible drawing commands');
  handlers.resize();
  handlers.resize();
  assert.equal(frames.size, 1);
  assert.deepEqual(trace, moving, 'resize must repaint the same moment, without advancing motion');
  document.hidden = true;
  handlers.visibilitychange();
  handlers.visibilitychange();
  handlers.resize();
  assert.equal(frames.size, 0);
  assert.equal(canvas.dataset.motion, 'paused');
  document.hidden = false;
  handlers.visibilitychange();
  handlers.visibilitychange();
  assert.deepEqual(tick(65000), moving, 'the first resumed frame must retain the scene before the long pause');
  const next = tick(65017);
  assert.notDeepEqual(next, moving, 'motion must continue after resuming');
  handlers.intersection([{ isIntersecting: false }]);
  handlers.resize();
  assert.equal(frames.size, 0);
  handlers.intersection([{ isIntersecting: true }]);
  handlers.intersection([{ isIntersecting: true }]);
  assert.deepEqual(tick(125000), next, 'time outside the viewport must also leave the scene in place');
});

test('pointer movement leaves the artwork stationary while trails and the emblem sheen keep moving', async () => {
  const { handlers, tick, sheen, sceneStyleWrites } = await rendererHarness();
  const opening = tick(1000);
  const openingSheen = sheen.style.backgroundPosition;
  handlers.pointermove?.({ clientX: 1000, clientY: 600 });
  const moving = tick(1017);
  assert.deepEqual(sceneStyleWrites, [], 'the cursor must not translate the hero artwork');
  assert.notDeepEqual(moving, opening, 'light trails must continue animating on the stationary artwork');
  assert.notEqual(sheen.style.backgroundPosition, openingSheen, 'the emblem sheen must continue animating');
  handlers.pointerleave?.();
  tick(1034);
  assert.deepEqual(sceneStyleWrites, [], 'leaving the hero must not introduce a scene translation');
});

function colorful(value) {
  if (Array.isArray(value)) return value.some(([, color]) => colorful(color));
  if (typeof value !== 'string') return false;
  let rgb;
  if (/^#[\da-f]{6}$/i.test(value)) rgb = [1, 3, 5].map(offset => Number.parseInt(value.slice(offset, offset + 2), 16));
  else if (/^rgba?\(/.test(value)) rgb = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  return rgb?.length === 3 && Math.max(...rgb) - Math.min(...rgb) > 50;
}

test('the opening scene contains saturated source-over ink so trails retain color on a bright backdrop', async () => {
  const { trace } = await rendererHarness();
  assert.ok(trace.some(command => command.type === 'stroke' && command.composite === 'source-over' &&
    command.alpha > .1 && colorful(command.style)), 'at least one colored stroke must use normal compositing, rather than whitening the entire ribbon');
});
