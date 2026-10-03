// Arc-length sampling keeps light moving smoothly through the ribbon bends.
// The original scene, glass lens and brand mark remain stationary.
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
    sprite.width = sprite.height = 64;
    const ctx = sprite.getContext('2d');
    const glow = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    glow.addColorStop(0, 'rgba(255,255,246,.7)');
    glow.addColorStop(.2, `rgba(${rgb},.4)`);
    glow.addColorStop(.55, `rgba(${rgb},.1)`);
    glow.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 64, 64);
    return sprite;
  }
  const routes = [
    { ...makeRoute([85, 765], [[265, 711, 610, 659, 780, 584], [840, 557, 793, 526, 769, 509], [719, 474, 817, 452, 898, 435]]), rgb: '248,177,54', phase: .18, speed: 128 },
    { ...makeRoute([1340, 432], [[1420, 444, 1534, 466, 1574, 491], [1664, 547, 1444, 568, 1277, 602]]), rgb: '40,224,188', phase: .54, speed: 114 },
  ].map(route => ({ ...route, glow: glowSprite(route.rgb),
    colors: Array.from({ length: 64 }, (_, index) => `rgba(${route.rgb},${index / 63})`),
    cores: Array.from({ length: 64 }, (_, index) => `rgba(255,255,247,${index / 63})`),
  }));
  const filaments = [
    { offset: 0, tail: 350, phase: 0, speed: 1, width: 4, bloom: 34, power: .8 },
    { offset: -8, tail: 240, phase: .36, speed: .94, width: 1.8, bloom: 22, power: .5 },
    { offset: 8, tail: 285, phase: .7, speed: 1.06, width: 2.2, bloom: 26, power: .6 },
  ];
  function drawTrail(route, filament, clock) {
    const travel = route.length + filament.tail;
    const head = (clock * route.speed * filament.speed + (route.phase + filament.phase) * travel) % travel;
    const start = Math.max(0, head - filament.tail);
    const end = Math.min(route.length, head);
    if (start >= end) return;
    const segments = Math.ceil((end - start) / 5);
    let previous = pointOn(route, start, filament.offset);
    context.lineCap = 'butt';
    context.lineJoin = 'round';
    for (let index = 1; index <= segments; index++) {
      const distance = start + (end - start) * index / segments;
      const point = pointOn(route, distance, filament.offset);
      const alpha = trailOpacity(distance, head, filament.tail, route.length) * filament.power;
      if (index % 2 === 0) {
        context.globalAlpha = alpha * .55;
        context.drawImage(route.glow, point.x - filament.bloom / 2, point.y - filament.bloom / 2, filament.bloom, filament.bloom);
      }
      context.globalAlpha = 1;
      const color = Math.min(63, Math.round(alpha * 63));
      context.beginPath();
      context.moveTo(previous.x, previous.y);
      context.lineTo(point.x, point.y);
      context.strokeStyle = route.colors[color];
      context.lineWidth = filament.width;
      context.stroke();
      context.strokeStyle = route.cores[Math.round(color * .8)];
      context.lineWidth = filament.width * .3;
      context.stroke();
      previous = point;
    }
  }
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
    context.globalCompositeOperation = 'lighter';
    for (const route of routes) for (const filament of filaments) drawTrail(route, filament, clock);
    context.globalAlpha = 1;
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
