// Light travels at a constant distance along each ribbon, including its bends.
// The scene, lens and brand emblem never move.
const canvas = document.querySelector('#hero-streams');
const context = canvas.getContext('2d');
const width = 1659;
const height = 948;

function makeRoute(start, curves) {
  const points = [{ x: start[0], y: start[1], distance: 0 }];
  let from = start;
  for (const curve of curves) {
    for (let step = 1; step <= 140; step++) {
      const t = step / 140;
      const v = 1 - t;
      const x = v ** 3 * from[0] + 3 * v ** 2 * t * curve[0] + 3 * v * t ** 2 * curve[2] + t ** 3 * curve[4];
      const y = v ** 3 * from[1] + 3 * v ** 2 * t * curve[1] + 3 * v * t ** 2 * curve[3] + t ** 3 * curve[5];
      const previous = points.at(-1);
      points.push({ x, y, distance: previous.distance + Math.hypot(x - previous.x, y - previous.y) });
    }
    from = curve.slice(4);
  }
  return { points, length: points.at(-1).distance };
}

function pointOn(route, distance, offset = 0) {
  let low = 1;
  let high = route.points.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (route.points[middle].distance < distance) low = middle + 1;
    else high = middle;
  }
  const a = route.points[low - 1];
  const b = route.points[low];
  const fraction = Math.max(0, Math.min(1, (distance - a.distance) / (b.distance - a.distance || 1)));
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: a.x + (b.x - a.x) * fraction - (b.y - a.y) / length * offset, y: a.y + (b.y - a.y) * fraction + (b.x - a.x) / length * offset };
}

function glowSprite(rgb) {
  const sprite = document.createElement('canvas');
  sprite.width = sprite.height = 64;
  const ctx = sprite.getContext('2d');
  const glow = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  glow.addColorStop(0, `rgba(${rgb},.9)`);
  glow.addColorStop(.22, `rgba(${rgb},.48)`);
  glow.addColorStop(.5, `rgba(${rgb},.14)`);
  glow.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = glow; ctx.fillRect(0, 0, 64, 64);
  return sprite;
}

const routes = [
  { ...makeRoute([400, 660], [[555, 640, 898, 598, 825, 555], [795, 536, 716, 521, 763, 487], [790, 464, 839, 451, 900, 436]]), rgb: '246,155,29', glow: glowSprite('255,192,55'), tail: 275, cycle: 4.2, phase: 0 },
  { ...makeRoute([1338, 430], [[1413, 441, 1541, 463, 1578, 494], [1617, 527, 1445, 554, 1338, 574]]), rgb: '0,178,153', glow: glowSprite('68,246,214'), tail: 250, cycle: 4, phase: .24 }
];

function drawTrail(route, clock, phase, offset, fine = false) {
  const head = ((clock / route.cycle + phase) % 1) * (route.length + route.tail);
  const tail = fine ? route.tail * .63 : route.tail;
  const start = Math.max(0, head - tail);
  const end = Math.min(route.length, head);
  if (start >= end) return;
  const envelope = Math.min(1, head / 24, (route.length + tail - head) / 30);
  if (envelope <= 0) return;
  const segments = Math.ceil((end - start) / 5);
  const samples = Array.from({ length: segments + 1 }, (_, index) => {
    const distance = start + (end - start) * index / segments;
    const strength = Math.max(0, 1 - (head - distance) / tail) ** 1.35 * envelope;
    return { ...pointOn(route, distance, offset), strength };
  });
  // Cached radial sprites create the bloom without per-frame shadow filters.
  for (let index = 0; index < samples.length; index += 2) {
    const point = samples[index];
    const size = fine ? 24 : 40;
    context.globalAlpha = point.strength * (fine ? .4 : .6);
    context.drawImage(route.glow, point.x - size / 2, point.y - size / 2, size, size);
  }
  context.globalAlpha = 1;
  context.lineCap = 'round'; context.lineJoin = 'round';
  for (let index = 1; index < samples.length; index++) {
    const a = samples[index - 1]; const b = samples[index];
    context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y);
    context.strokeStyle = `rgba(${route.rgb},${b.strength * .95})`;
    context.lineWidth = fine ? 1.9 : 5.5; context.stroke();
    context.strokeStyle = `rgba(255,255,244,${b.strength * .9})`;
    context.lineWidth = fine ? .65 : 1.5; context.stroke();
  }
  if (!fine && head <= route.length) {
    const tip = pointOn(route, head, offset);
    context.globalAlpha = envelope;
    context.drawImage(route.glow, tip.x - 23, tip.y - 23, 46, 46);
    context.beginPath(); context.arc(tip.x, tip.y, 2.1, 0, Math.PI * 2);
    context.fillStyle = '#fffef0'; context.fill(); context.globalAlpha = 1;
  }
}

let clock = 0;
let previousTime = 0;
let frame = 0;
let scaleX = 1;
let scaleY = 1;
function resize() {
  const rect = canvas.getBoundingClientRect();
  const density = Math.min(window.devicePixelRatio || 1, 1.7);
  canvas.width = Math.max(1, Math.round(rect.width * density));
  canvas.height = Math.max(1, Math.round(rect.height * density));
  scaleX = canvas.width / width; scaleY = canvas.height / height;
  paint();
}
function paint() {
  context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  context.clearRect(0, 0, width, height);
  for (const route of routes) {
    drawTrail(route, clock, route.phase, 0);
    drawTrail(route, clock, route.phase + .5, 0);
    drawTrail(route, clock * 1.09, route.phase + .28, 7, true);
  }
}
function tick(time) {
  if (previousTime) clock += Math.min(time - previousTime, 50) / 1000;
  previousTime = time; paint(); frame = requestAnimationFrame(tick);
}
function sync() {
  const paused = document.hidden || document.documentElement.matches('.motion-paused, .hero-offscreen, .page-inactive');
  canvas.dataset.motion = paused ? 'paused' : 'running';
  if (paused && frame) { cancelAnimationFrame(frame); frame = 0; previousTime = 0; }
  else if (!paused && !frame) { previousTime = 0; frame = requestAnimationFrame(tick); }
}
new ResizeObserver(resize).observe(canvas);
new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
document.addEventListener('visibilitychange', sync);
resize(); sync();
