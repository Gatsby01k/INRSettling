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

test('reduced motion, hidden tabs and offscreen canvases stop work; resuming schedules one frame', async () => {
  const source = (await readFile(new URL('../public/hero-flow.js', import.meta.url), 'utf8')).replace(/^export /gm, '');
  const frames = new Map();
  const handlers = {};
  const media = { matches: true, addEventListener: (_name, fn) => { handlers.media = fn; } };
  const ctx = { createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, setTransform() {}, clearRect() {}, drawImage() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} };
  const canvas = { dataset: {}, getContext: () => ctx, getBoundingClientRect: () => ({ width: 1000, height: 600 }) };
  const document = { hidden: false, querySelector: () => canvas, createElement: () => ({ getContext: () => ctx }), addEventListener: (name, fn) => { handlers[name] = fn; } };
  let nextFrame = 1;
  const sandbox = { document, window: { matchMedia: () => media, devicePixelRatio: 2, IntersectionObserver: true },
    requestAnimationFrame: fn => { const id = nextFrame++; frames.set(id, fn); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    ResizeObserver: class { constructor(fn) { handlers.resize = fn; } observe() {} },
    IntersectionObserver: class { constructor(fn) { handlers.intersection = fn; } observe() {} },
  };
  vm.runInNewContext(source, sandbox);
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
  const [id, fn] = [...frames][0];
  frames.delete(id);
  fn(16);
  assert.equal(frames.size, 1);
  media.matches = true;
  handlers.media();
  assert.equal(canvas.dataset.motion, 'paused');
  assert.equal(frames.size, 0);
});
