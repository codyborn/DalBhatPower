/**
 * Server-rendered, crawlable pages for search engines and link previews:
 *   /town/{townKey}  – live dal bhat prices for one town
 *   /towns           – index of every town with prices
 *   /sitemap.xml     – for search engines
 * The interactive app stays a single page; these are plain HTML that link into it.
 */
const SITE = (process.env.SITE_URL || 'https://dalbhatpower.net').replace(/\/$/, '');
const MONTHS = 12;
const MEAL_LABEL = { veg: 'Veg', chicken: 'Chicken', egg: 'Egg', mutton: 'Mutton', fish: 'Fish', other: 'Other' };
const VENUE_LABEL = { local: 'local bhojanalaya', teahouse: 'trekking teahouse', restaurant: 'restaurant' };
const VENUE_PLURAL = { local: 'local bhojanalayas', teahouse: 'trekking teahouses', restaurant: 'restaurants' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rs = (n) => (n == null ? '—' : `Rs ${Math.round(n).toLocaleString('en-IN')}`);
const metres = (n) => (n == null ? null : `${Math.round(n).toLocaleString('en-US')} m`);
const isoDate = (d) => d.toISOString().slice(0, 10);
const niceDate = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const shortDate = (d) => d.toLocaleDateString('en-GB', d.getFullYear() === new Date().getFullYear()
  ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: '2-digit' });

function median(values) {
  const a = values.filter((x) => typeof x === 'number').sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function since(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d;
}

async function recentReports(db, Timestamp, extra = (q) => q, limit = 5000) {
  let q = db.collection('reports').where('status', '==', 'visible');
  q = extra(q).where('observedAt', '>=', Timestamp.fromDate(since(MONTHS))).orderBy('observedAt', 'desc').limit(limit);
  const snap = await q.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data(), observedAt: d.data().observedAt.toDate() }));
}

function townSummaries(reports) {
  const towns = new Map();
  for (const r of reports) {
    if (!towns.has(r.townKey)) towns.set(r.townKey, { key: r.townKey, names: {}, reports: [] });
    const t = towns.get(r.townKey);
    t.names[r.town] = (t.names[r.town] || 0) + 1;
    t.reports.push(r);
  }
  return [...towns.values()].map((t) => {
    const veg = t.reports.filter((r) => r.meal === 'veg').map((r) => r.priceNpr);
    return {
      key: t.key,
      name: Object.entries(t.names).sort((a, b) => b[1] - a[1])[0][0],
      n: t.reports.length,
      vegMedian: median(veg),
      allMedian: median(t.reports.map((r) => r.priceNpr)),
      elevation: median(t.reports.map((r) => r.elevation)),
      lat: median(t.reports.map((r) => r.lat)),
      lng: median(t.reports.map((r) => r.lng)),
      updated: t.reports.reduce((m, r) => (r.observedAt > m ? r.observedAt : m), new Date(0)),
    };
  });
}

function layout({ title, description, canonical, body, jsonLd }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="theme-color" content="#b45309">
<meta name="color-scheme" content="light">
<link rel="icon" href="/icons/icon-192.png" type="image/png">
<link rel="manifest" href="/manifest.webmanifest">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Dal Bhat Power">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${SITE}/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>` : ''}
<style>
  :root { color-scheme: light; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #fbf7f0; color: #2a2118; line-height: 1.5; }
  header { background: #fff; border-bottom: 1px solid #eadfce; padding: 12px 16px; }
  header a { color: #2a2118; text-decoration: none; font-weight: 700; }
  main { max-width: 760px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 8px 0 4px; }
  .muted { color: #7a6a58; }
  a { color: #b45309; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin: 16px 0; }
  .stat { background: #fff; border: 1px solid #eadfce; border-radius: 12px; padding: 12px; text-align: center; }
  .stat b { display: block; font-size: 1.4rem; color: #b45309; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #eadfce; border-radius: 12px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eadfce; font-size: .95rem; }
  th { color: #7a6a58; font-weight: 500; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .nowrap { white-space: nowrap; }
  .cta.ghost { background: #fff; color: #b45309; border: 1.5px solid #b45309; }
  .cta { display: inline-block; background: #b45309; color: #fff; padding: 10px 18px; border-radius: 999px; text-decoration: none; font-weight: 700; margin: 8px 8px 8px 0; }
  .card { background: #fff; border: 1px solid #eadfce; border-radius: 12px; padding: 14px; margin: 16px 0; }
  footer { max-width: 760px; margin: 0 auto; padding: 16px; font-size: .85rem; color: #7a6a58; }
</style>
</head>
<body>
<header><a href="/"><img src="/icons/icon-192.png" alt="" width="28" height="28" style="border-radius:7px;vertical-align:middle;margin-right:8px">Dal Bhat Power</a></header>
<main>${body}</main>
<footer>Crowdsourced by trekkers and travellers. Prices are reported from menu photos and may change. Elevations from Open-Meteo. <a href="/towns">All towns</a> · <a href="/">Open the map</a></footer>
</body>
</html>`;
}

function notFound(res, key) {
  res.status(404).set('Cache-Control', 'public, max-age=300, s-maxage=600').send(layout({
    title: 'No prices yet | Dal Bhat Power',
    description: 'No dal bhat prices have been reported for this place yet.',
    canonical: `${SITE}/towns`,
    body: `<h1>No prices for “${esc(key)}” yet</h1>
      <p>Nobody has reported a dal bhat price here in the last ${MONTHS} months. Be the first!</p>
      <a class="cta" href="/?view=add">＋ Add a price</a> <a href="/towns">See all towns</a>`,
  }));
}

async function townPage(db, Timestamp, key, res) {
  const reports = await recentReports(db, Timestamp, (q) => q.where('townKey', '==', key), 500);
  if (!reports.length) return notFound(res, key);
  const [t] = townSummaries(reports);

  const byMeal = Object.keys(MEAL_LABEL)
    .map((m) => ({ m, prices: reports.filter((r) => r.meal === m).map((r) => r.priceNpr) }))
    .filter((x) => x.prices.length)
    .map((x) => ({ label: MEAL_LABEL[x.m], median: median(x.prices), n: x.prices.length, min: Math.min(...x.prices), max: Math.max(...x.prices) }));
  const venues = [...new Set(reports.map((r) => r.venueType))].map((v) => VENUE_PLURAL[v] || v);
  const headline = t.vegMedian ?? t.allMedian;
  const elev = metres(t.elevation);
  const title = `Dal bhat price in ${t.name}, Nepal: ${rs(headline)}${t.vegMedian != null ? ' veg' : ''} | Dal Bhat Power`;
  const description = `A plate of dal bhat in ${t.name}${elev ? ` (${elev})` : ''} costs about ${rs(headline)}`
    + `${t.vegMedian != null ? ' for veg' : ''}, based on ${t.n} recent report${t.n > 1 ? 's' : ''} from ${venues.join(' and ')}. Updated ${niceDate(t.updated)}.`;
  const canonical = `${SITE}/town/${encodeURIComponent(key)}`;

  const rows = reports.slice(0, 25).map((r) => `<tr>
      <td class="nowrap">${esc(shortDate(r.observedAt))}</td>
      <td>${esc(MEAL_LABEL[r.meal] || r.meal)}</td>
      <td>${esc(r.venueName || VENUE_LABEL[r.venueType] || '')}</td>
      <td class="num">${rs(r.priceNpr)}</td></tr>`).join('');

  const body = `
    <p class="muted">Nepal${elev ? ` · ${elev} elevation` : ''}</p>
    <h1>How much is dal bhat in ${esc(t.name)}?</h1>
    <p>${esc(description.replace(/ \| .*$/, ''))}</p>
    <div class="stats">
      ${byMeal.map((x) => `<div class="stat"><b>${rs(x.median)}</b>${esc(x.label)} plate<br><span class="muted">${x.n} report${x.n > 1 ? 's' : ''}</span>${x.n > 1 ? `<br><span class="muted nowrap">${rs(x.min)}–${rs(x.max)}</span>` : ''}</div>`).join('')}
    </div>
    <a class="cta" href="/?town=${encodeURIComponent(key)}">See ${esc(t.name)} on the map</a>
    <a class="cta ghost" href="/?view=add">＋ Add a price</a>
    <h2>Latest prices</h2>
    <table>
      <thead><tr><th>Date</th><th>Plate</th><th>Where</th><th class="num">Price</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="card"><b>About these prices.</b> Medians over the last ${MONTHS} months. Prices usually include unlimited refills of rice and dal. Trekking teahouses higher up charge more because supplies are carried in by porters and mules.</div>`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Place',
        name: t.name,
        address: { '@type': 'PostalAddress', addressCountry: 'NP' },
        ...(t.lat != null ? { geo: { '@type': 'GeoCoordinates', latitude: t.lat, longitude: t.lng, ...(t.elevation != null ? { elevation: Math.round(t.elevation) } : {}) } } : {}),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Dal Bhat Power', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: 'Towns', item: `${SITE}/towns` },
          { '@type': 'ListItem', position: 3, name: t.name, item: canonical },
        ],
      },
    ],
  };

  res.set('Cache-Control', 'public, max-age=600, s-maxage=3600').send(layout({ title, description, canonical, body, jsonLd }));
}

async function townsPage(db, Timestamp, res) {
  const towns = townSummaries(await recentReports(db, Timestamp)).sort((a, b) => b.n - a.n);
  const rows = towns.map((t) => `<tr>
      <td><a href="/town/${encodeURIComponent(t.key)}">${esc(t.name)}</a></td>
      <td class="num">${rs(t.vegMedian ?? t.allMedian)}</td>
      <td class="num">${esc(metres(t.elevation) || '—')}</td>
      <td class="num">${t.n}</td></tr>`).join('');
  const description = `Crowdsourced dal bhat prices in ${towns.length} towns and trekking villages across Nepal, from Kathmandu to Everest Base Camp.`;
  res.set('Cache-Control', 'public, max-age=600, s-maxage=3600').send(layout({
    title: 'Dal bhat prices across Nepal, town by town | Dal Bhat Power',
    description,
    canonical: `${SITE}/towns`,
    body: `<h1>Dal bhat prices across Nepal</h1><p>${esc(description)} Median plate price over the last ${MONTHS} months (veg where reported).</p>
      <a class="cta" href="/">Open the map</a>
      <table><thead><tr><th>Town</th><th class="num">Median</th><th class="num">Elevation</th><th class="num">Reports</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">No prices yet.</td></tr>'}</tbody></table>`,
  }));
}

async function sitemap(db, Timestamp, res) {
  const towns = townSummaries(await recentReports(db, Timestamp));
  const today = isoDate(new Date());
  const urls = [
    { loc: `${SITE}/`, lastmod: today },
    { loc: `${SITE}/towns`, lastmod: today },
    ...towns.map((t) => ({ loc: `${SITE}/town/${encodeURIComponent(t.key)}`, lastmod: isoDate(t.updated) })),
  ];
  res.set('Content-Type', 'application/xml').set('Cache-Control', 'public, max-age=3600, s-maxage=21600').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
      urls.map((u) => `  <url><loc>${esc(u.loc)}</loc><lastmod>${u.lastmod}</lastmod></url>`).join('\n')}\n</urlset>\n`,
  );
}

/** Express-style handler; db and Timestamp come from index.js so the named database is reused. */
function handler(db, Timestamp) {
  return async (req, res) => {
    try {
      const path = req.path.replace(/\/+$/, '') || '/';
      const m = path.match(/^\/town\/([a-z0-9-]{1,60})$/);
      if (m) return await townPage(db, Timestamp, m[1], res);
      if (path === '/towns') return await townsPage(db, Timestamp, res);
      if (path === '/sitemap.xml') return await sitemap(db, Timestamp, res);
      return notFound(res, path.replace(/^\/town\//, ''));
    } catch (err) {
      console.error('seo page failed', err);
      res.status(500).set('Cache-Control', 'no-store').send('Something went wrong. <a href="/">Open the map</a>');
    }
  };
}

module.exports = { handler };
