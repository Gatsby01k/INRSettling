// Saturated energy pulses follow the artwork; the lens and base catch the light.
// Arc-length sampling keeps every bend smooth on the stationary artwork.
const ART_WIDTH = 1659;
const ART_HEIGHT = 948;

export function makeRoute(start, curves) {
  const points = [{ x: start[0], y: start[1], distance: 0 }];
  let from = start;
  for (const curve of curves) {
    for (let step = 1; step <= 180; step++) {
      const t = step / 180;
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

export function pointOn(route, distance, offset = 0) {
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
  const segment = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: a.x + (b.x - a.x) * fraction - (b.y - a.y) / segment * offset,
    y: a.y + (b.y - a.y) * fraction + (b.x - a.x) / segment * offset };
}

const smooth = value => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

export function trailOpacity(distance, head, tail, length) {
  const body = smooth(1 - (head - distance) / tail);
  const leadingEdge = smooth((head - distance) / 24);
  return body * leadingEdge * smooth(distance / 80) * smooth((length - distance) / 65);
}

function animate(canvas, context) {
  function glowSprite(rgb) {
    const sprite = document.createElement('canvas');
    sprite.width = sprite.height = 128;
    const ctx = sprite.getContext('2d');
    const glow = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    glow.addColorStop(0, `rgba(${rgb},.7)`);
    glow.addColorStop(.25, `rgba(${rgb},.4)`);
    glow.addColorStop(.6, `rgba(${rgb},.12)`);
    glow.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 128, 128);
    return sprite;
  }
  function flareSprite(rgb) {
    const sprite = glowSprite(rgb);
    const ctx = sprite.getContext('2d');
    const core = ctx.createRadialGradient(64, 64, 0, 64, 64, 12);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(.3, 'rgba(255,255,250,.85)');
    core.addColorStop(1, 'rgba(255,255,250,0)');
    ctx.fillStyle = core;
    ctx.fillRect(52, 52, 24, 24);
    for (let step = 1; step <= 20; step++) {
      const alpha = (1 - step / 21) ** 2;
      ctx.strokeStyle = `rgba(255,255,252,${alpha * .65})`;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(64 - step * 2, 64);
      ctx.lineTo(64 + step * 2, 64);
      ctx.stroke();
    }
    return sprite;
  }
  const routes = [
    { ...makeRoute([380, 703], [[460, 688, 630, 650, 780, 584], [840, 557, 793, 526, 769, 509], [719, 474, 817, 452, 898, 435]]), rgb: '242,145,12', phase: .56 },
    { ...makeRoute([1340, 432], [[1420, 444, 1534, 466, 1574, 491], [1664, 547, 1444, 568, 1277, 602]]), rgb: '0,174,154', phase: .46 },
  ].map(route => ({ ...route, glow: glowSprite(route.rgb), flare: flareSprite(route.rgb),
    colors: Array.from({ length: 64 }, (_, index) => `rgba(${route.rgb},${index / 63})`),
    cores: Array.from({ length: 64 }, (_, index) => `rgba(255,255,247,${index / 63})`),
  }));
  const filaments = [
    { offset: 0, tail: 490, phase: 0, width: 9, core: 2.8, bloom: 56, power: .95 },
    { offset: -14, tail: 340, phase: .34, width: 3.2, core: 1.3, bloom: 30, power: .75 },
    { offset: 14, tail: 300, phase: .68, width: 4, core: 1.5, bloom: 34, power: .8 },
  ];
  const CYCLE = 6.6;
  function lightAt(route, head, tail, distance) {
    const alpha = trailOpacity(distance, head, tail, route.length);
    const crest = Math.exp(-(((head - distance - 36) / 28) ** 2));
    return { alpha, crest };
  }
  function strokeSegment(a, b, color, width) {
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.strokeStyle = color;
    context.lineWidth = width;
    context.stroke();
  }
  function drawTrail(route, filament, clock) {
    const travel = route.length + filament.tail;
    const head = ((clock / CYCLE + route.phase + filament.phase) % 1) * travel;
    const start = Math.max(0, head - filament.tail);
    const end = Math.min(route.length, head);
    if (start >= end) return;
    const segments = Math.ceil((end - start) / 8);
    let previous = pointOn(route, start, filament.offset);
    context.lineCap = 'butt';
    context.lineJoin = 'round';
    // Bloom adds volume; source-over keeps the body colored on the pale artwork.
    for (let distance = start; distance < end; distance += 16) {
      const point = pointOn(route, distance, filament.offset);
      const { alpha, crest } = lightAt(route, head, filament.tail, distance);
      const size = filament.bloom * (1 + crest * .65);
      context.globalAlpha = alpha * (.28 + crest * .3) * filament.power;
      context.drawImage(route.glow, point.x - size / 2, point.y - size / 2, size, size);
    }
    context.globalAlpha = 1;
    for (let index = 1; index <= segments; index++) {
      const distance = start + (end - start) * index / segments;
      const point = pointOn(route, distance, filament.offset);
      const { alpha, crest } = lightAt(route, head, filament.tail, distance);
      const color = Math.min(63, Math.round(alpha * filament.power * 63));
      strokeSegment(previous, point, route.colors[color], filament.width * (1 + crest * .4));
      const core = Math.round(color * (.35 + crest * .55));
      strokeSegment(previous, point, route.cores[core], filament.core * (1 + crest * .25));
      previous = point;
    }
    if (filament.offset === 0) {
      const distance = Math.max(0, Math.min(route.length, head - 36));
      const point = pointOn(route, distance);
      context.globalAlpha = trailOpacity(distance, head, filament.tail, route.length) * .9;
      context.drawImage(route.flare, point.x - 45, point.y - 22, 90, 44);
      context.globalAlpha = 1;
    }
  }
  function orbitArc(route, head) {
    const sweep = 1.15;
    const segments = 24;
    context.lineCap = 'butt';
    for (let index = 0; index < segments; index++) {
      const t = (index + .5) / segments;
      const intensity = Math.sin(Math.PI * t) ** .7;
      const start = head - sweep + sweep * index / segments;
      const end = start + sweep / segments + .002;
      context.beginPath();
      context.ellipse(1115, 443, 213, 235, .25, start, end);
      context.strokeStyle = route.colors[Math.round(intensity * 44)];
      context.lineWidth = 6;
      context.stroke();
      context.strokeStyle = route.cores[Math.round(intensity * 54)];
      context.lineWidth = 1.7;
      context.stroke();
    }
    const theta = head - sweep * .3;
    const x = Math.cos(theta) * 213;
    const y = Math.sin(theta) * 235;
    const px = 1115 + x * Math.cos(.25) - y * Math.sin(.25);
    const py = 443 + x * Math.sin(.25) + y * Math.cos(.25);
    context.globalAlpha = .85;
    context.drawImage(route.flare, px - 50, py - 35, 100, 70);
    context.globalAlpha = 1;
  }
  function floorWave(phase) {
    const alpha = Math.sin(Math.PI * phase) ** 1.5;
    const rx = 430 + phase * 105;
    const ry = 86 + phase * 23;
    context.beginPath();
    context.ellipse(1110, 750 + phase * 9, rx, ry, 0, .12, Math.PI - .12);
    context.strokeStyle = routes[1].colors[Math.round(alpha * 23)];
    context.lineWidth = 4;
    context.stroke();
    context.strokeStyle = routes[1].cores[Math.round(alpha * 32)];
    context.lineWidth = 1.2;
    context.stroke();
  }
  function drawLens(clock) {
    context.save();
    const angle = clock / CYCLE * Math.PI * 2 - 1.5;
    orbitArc(routes[0], angle);
    orbitArc(routes[1], angle + Math.PI);
    floorWave((clock / CYCLE + .25) % 1);
    floorWave((clock / CYCLE + .75) % 1);
    context.restore();
  }
  const visual = canvas.parentElement;
  const sheen = visual?.querySelector('.hero-emblem-sheen');
  let clock = 0;
  let previousTime = 0;
  let lastPaint = 0;
  let frame = 0;
  let scaleX = 1;
  let scaleY = 1;
  let onScreen = true;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  function paint() {
    context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    context.clearRect(0, 0, ART_WIDTH, ART_HEIGHT);
    context.globalCompositeOperation = 'source-over';
    for (const route of routes) for (const filament of filaments) drawTrail(route, filament, clock);
    drawLens(clock);
    context.globalAlpha = 1;
    if (sheen) {
      const phase = (clock / CYCLE + .2) % 1;
      sheen.style.backgroundPosition = `${180 - phase * 360}% 50%`;
    }
  }
  function resize() {
    const rect = canvas.getBoundingClientRect();
    const density = Math.min(window.devicePixelRatio || 1, 1.7);
    canvas.width = Math.max(1, Math.round(rect.width * density));
    canvas.height = Math.max(1, Math.round(rect.height * density));
    scaleX = canvas.width / ART_WIDTH;
    scaleY = canvas.height / ART_HEIGHT;
    paint();
  }
  function tick(time) {
    if (previousTime) clock += Math.min(time - previousTime, 100) / 1000;
    previousTime = time;
    // Limit the backdrop to 60 paints per second on high-refresh screens.
    if (time - lastPaint >= 1000 / 60 - 1) { paint(); lastPaint = time; }
    frame = requestAnimationFrame(tick);
  }
  function sync() {
    const paused = document.hidden || reducedMotion.matches || !onScreen;
    canvas.dataset.motion = paused ? 'paused' : 'running';
    if (paused) {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      previousTime = 0;
      lastPaint = 0;
    } else if (!frame) {
      frame = requestAnimationFrame(tick);
    }
  }
  new ResizeObserver(resize).observe(canvas);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => { onScreen = entries[0].isIntersecting; sync(); }).observe(canvas);
  }
  document.addEventListener('visibilitychange', sync);
  reducedMotion.addEventListener('change', sync);
  resize();
  sync();
}

const canvas = typeof document !== 'undefined' ? document.querySelector('#hero-streams') : null;
const context = canvas?.getContext('2d');
if (context) animate(canvas, context);
