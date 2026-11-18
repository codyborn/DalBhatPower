// Tiny dependency-free SVG charts: a scatter (price vs elevation) and a line (price over time).
const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}

function niceTicks(min, max, count = 5) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return { lo, hi, ticks };
}

function frame(container, { width = 640, height = 340, xLabel, yLabel }) {
  container.innerHTML = '';
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart', role: 'img' });
  container.appendChild(svg);
  const m = { top: 16, right: 16, bottom: 46, left: 60 };
  const iw = width - m.left - m.right;
  const ih = height - m.top - m.bottom;
  const g = el('g', { transform: `translate(${m.left},${m.top})` });
  svg.appendChild(g);
  if (xLabel) svg.appendChild(el('text', { x: m.left + iw / 2, y: height - 6, class: 'axis-label', 'text-anchor': 'middle' }, xLabel));
  if (yLabel) svg.appendChild(el('text', { x: 14, y: m.top + ih / 2, class: 'axis-label', 'text-anchor': 'middle', transform: `rotate(-90 14 ${m.top + ih / 2})` }, yLabel));
  return { svg, g, iw, ih };
}

function axes(g, iw, ih, xt, yt, sx, sy, fmtX = String, fmtY = String) {
  for (const t of yt.ticks) {
    const y = sy(t);
    g.appendChild(el('line', { x1: 0, x2: iw, y1: y, y2: y, class: 'grid' }));
    g.appendChild(el('text', { x: -8, y: y + 4, class: 'tick', 'text-anchor': 'end' }, fmtY(t)));
  }
  for (const t of xt.ticks) {
    const x = sx(t);
    g.appendChild(el('text', { x, y: ih + 18, class: 'tick', 'text-anchor': 'middle' }, fmtX(t)));
  }
  g.appendChild(el('line', { x1: 0, x2: iw, y1: ih, y2: ih, class: 'axis' }));
}

/** Least-squares fit y = a + b x */
export function linearFit(points) {
  const n = points.length;
  if (n < 3) return null;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0, den = 0;
  for (const p of points) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
  if (den === 0) return null;
  const b = num / den;
  return { a: my - b * mx, b };
}

/**
 * points: [{x, y, r?, label, onClick?}]
 */
export function scatterChart(container, points, opts = {}) {
  if (!points.length) { container.innerHTML = '<p class="empty">Not enough data yet.</p>'; return; }
  const { g, iw, ih } = frame(container, opts);
  const xt = niceTicks(Math.min(0, ...points.map((p) => p.x)), Math.max(...points.map((p) => p.x)));
  const yt = niceTicks(Math.min(...points.map((p) => p.y)) * 0.9, Math.max(...points.map((p) => p.y)) * 1.05);
  const sx = (v) => ((v - xt.lo) / (xt.hi - xt.lo)) * iw;
  const sy = (v) => ih - ((v - yt.lo) / (yt.hi - yt.lo)) * ih;
  axes(g, iw, ih, xt, yt, sx, sy, opts.fmtX, opts.fmtY);

  const fit = linearFit(points);
  if (fit) {
    g.appendChild(el('line', {
      x1: sx(xt.lo), y1: sy(fit.a + fit.b * xt.lo), x2: sx(xt.hi), y2: sy(fit.a + fit.b * xt.hi), class: 'fit',
    }));
  }
  for (const p of points) {
    const c = el('circle', { cx: sx(p.x), cy: sy(p.y), r: p.r || 5, class: 'dot' });
    c.appendChild(el('title', {}, p.label));
    if (p.onClick) { c.style.cursor = 'pointer'; c.addEventListener('click', p.onClick); }
    g.appendChild(c);
  }
  return fit;
}

/**
 * series: [{x: Date, y: number, n: number}]
 */
export function lineChart(container, series, opts = {}) {
  if (series.length < 2) {
    container.innerHTML = '<p class="empty">Need at least two months of data for a trend.</p>';
    return;
  }
  const { g, iw, ih } = frame(container, opts);
  const xs = series.map((p) => p.x.getTime());
  const xt = { lo: Math.min(...xs), hi: Math.max(...xs), ticks: [] };
  const step = Math.max(1, Math.ceil(series.length / 6));
  xt.ticks = series.filter((_, i) => i % step === 0).map((p) => p.x.getTime());
  const yt = niceTicks(Math.min(...series.map((p) => p.y)) * 0.9, Math.max(...series.map((p) => p.y)) * 1.05);
  const sx = (v) => ((v - xt.lo) / (xt.hi - xt.lo || 1)) * iw;
  const sy = (v) => ih - ((v - yt.lo) / (yt.hi - yt.lo)) * ih;
  const fmtMonth = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  axes(g, iw, ih, xt, yt, sx, sy, fmtMonth, opts.fmtY);
  const d = series.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x.getTime())},${sy(p.y)}`).join(' ');
  g.appendChild(el('path', { d, class: 'line' }));
  for (const p of series) {
    const c = el('circle', { cx: sx(p.x.getTime()), cy: sy(p.y), r: 4, class: 'dot' });
    c.appendChild(el('title', {}, `${fmtMonth(p.x.getTime())}: Rs ${Math.round(p.y)} (n=${p.n})`));
    g.appendChild(c);
  }
}
