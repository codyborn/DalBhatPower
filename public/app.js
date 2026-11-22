// Dal Bhat Power — frontend (no build step; ES modules from CDNs).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged,
  signOut, connectAuthEmulator,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  connectFirestoreEmulator, collection, doc, getDoc, getDocs, setDoc, addDoc, writeBatch,
  deleteDoc, updateDoc, query, where, orderBy, limit, startAfter, serverTimestamp, Timestamp, getCountFromServer,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {
  getStorage, connectStorageEmulator, ref as storageRef, uploadBytes, deleteObject,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js';
import {
  getFunctions, connectFunctionsEmulator, httpsCallable,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js';

import { firebaseConfig, firestoreDatabase, functionsRegion, useEmulators, cartoKey } from './config.js';
import { TOWNS, townKey, nearestTown, inNepal, NEPAL_BOUNDS } from './towns.js';
import { readPhotoMeta, reencodeJpeg } from './photo.js';
import { TREKS, MAX_TREKS, knownTreks, trekBadge, trekBadges, countryName, countryOptions, flag } from './profile.js';
import { scatterChart, lineChart, linearFit } from './charts.js';

// ---------------------------------------------------------------- Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// Persistent cache: the map and feed still show the last-loaded data with no signal.
let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  }, firestoreDatabase || '(default)');
} catch (err) {
  console.warn('Offline cache unavailable', err);
  db = getFirestore(app, firestoreDatabase || '(default)');
}
const storage = getStorage(app);
// Fail fast on bad connections so the submission can be queued instead of hanging for minutes.
storage.maxUploadRetryTime = 20000;
storage.maxOperationRetryTime = 20000;
const functions = getFunctions(app, functionsRegion);
if (useEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
}
const moderateFn = httpsCallable(functions, 'moderate');
const fillElevationFn = httpsCallable(functions, 'fillElevation');
const setBannedFn = httpsCallable(functions, 'setBanned');

// ---------------------------------------------------------------- state
const state = {
  user: null,
  profile: null,
  isMod: false,
  reports: [],          // last 24 months of visible reports
  loaded: false,
  filters: { meal: 'veg', venue: 'all', months: 6 },
  feedCursor: null,
  feedDone: false,
  feedLoading: false,
};
const HISTORY_MONTHS = 24;
const MEAL_LABEL = { veg: 'Veg', chicken: 'Chicken', egg: 'Egg', mutton: 'Mutton', fish: 'Fish', other: 'Other' };
const DEFAULT_PLATES = ['veg', 'chicken', 'egg'];
const MAX_PLATES = 8;
const VENUE_LABEL = { local: 'Local bhojanalaya', teahouse: 'Teahouse', restaurant: 'Restaurant' };
const FLAG_REASONS = {
  'wrong-price': 'Wrong or fake price',
  'not-dal-bhat': 'Not dal bhat / not a menu',
  spam: 'Spam or advertising',
  offensive: 'Offensive or abusive',
  'private-info': 'Shows private information or a person',
  other: 'Something else',
};

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtRs = (n) => (n == null || isNaN(n) ? '—' : `Rs ${Math.round(n).toLocaleString('en-IN')}`);
const fmtM = (n) => (n == null ? '—' : `${Math.round(n).toLocaleString()} m`);
const toDate = (t) => (t instanceof Timestamp ? t.toDate() : t instanceof Date ? t : t ? new Date(t) : null);
const fmtDate = (d) => (d ? toDate(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const monthsAgo = (m) => { const d = new Date(); d.setMonth(d.getMonth() - m); return d; };

function median(arr) {
  const a = arr.filter((x) => typeof x === 'number' && !isNaN(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function photoUrl(path) {
  const host = useEmulators ? 'http://127.0.0.1:9199' : 'https://firebasestorage.googleapis.com';
  return `${host}/v0/b/${firebaseConfig.storageBucket}/o/${encodeURIComponent(path)}?alt=media`;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function friendlyError(err) {
  const code = err?.code || '';
  if (code.includes('permission-denied')) return 'Not allowed — are you signed in (and not already done this)?';
  if (code.includes('unauthenticated')) return 'Please sign in first.';
  if (code.includes('failed-precondition')) return 'The database index is still building — try again in a few minutes.';
  return err?.message || 'Something went wrong.';
}

const userCache = new Map();
function getUserInfo(uid) {
  if (!userCache.has(uid)) {
    userCache.set(uid, getDoc(doc(db, 'users', uid))
      .then((s) => (s.exists() ? s.data() : { displayName: 'Someone', reputation: 0 }))
      .catch(() => ({ displayName: 'Someone', reputation: 0 })));
  }
  return userCache.get(uid);
}

/** Name + flag + reputation + trek badges, as clickable HTML (opens the public profile). */
function userLabel(u) {
  const f = flag(u.homeCountry);
  return `<span class="who-name">${esc(u.displayName || 'Someone')}</span>${f ? ` <span title="${esc(countryName(u.homeCountry))}">${f}</span>` : ''} <span class="rep-mini">★${esc(u.reputation ?? 0)}</span>${trekBadges(u.treks)}`;
}

function canonicalTown(name) {
  const key = townKey(name);
  const seed = TOWNS.find((t) => t.key === key);
  return { town: seed ? seed.name : name.trim().replace(/\s+/g, ' '), townKey: key };
}

// ---------------------------------------------------------------- navigation
function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $('#filters').hidden = !['map', 'trends'].includes(name);
  if (name === 'map') setTimeout(() => map.invalidateSize(), 50);
  if (name === 'trends') renderTrends();
  if (name === 'feed' && !$('#feed').children.length) loadFeed(true);
  if (name === 'add') { setTimeout(initMiniMap, 50); warmGps(); }
  if (name === 'me') renderMe();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));

// ---------------------------------------------------------------- auth
async function signIn() {
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(err.code)) {
      await signInWithRedirect(auth, provider);
    } else if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
      toast(friendlyError(err));
    }
  }
}

onAuthStateChanged(auth, async (user) => {
  state.user = user;
  state.profile = null;
  state.isMod = false;
  if (user) {
    try {
      const token = await user.getIdTokenResult();
      state.isMod = token.claims.mod === true;
      const ref = doc(db, 'users', user.uid);
      let snap = await getDoc(ref);
      if (!snap.exists()) {
        await setDoc(ref, {
          displayName: (user.displayName || 'Dal bhat fan').slice(0, 60),
          photoURL: user.photoURL ? user.photoURL.slice(0, 500) : null,
          reputation: 0,
          createdAt: serverTimestamp(),
        });
        snap = await getDoc(ref);
      }
      state.profile = snap.data();
      userCache.set(user.uid, Promise.resolve(state.profile));
    } catch (err) {
      console.error(err);
      toast(friendlyError(err));
    }
  }
  renderAuth();
  $('#add-signin').hidden = !!user;
  $('#add-forms').hidden = !user;
  if ($('#view-me').classList.contains('active')) renderMe();
  if ($('#view-add').classList.contains('active')) setTimeout(initMiniMap, 50);
  if (user) { updateQueueStatus(); syncQueue({ quiet: true }); }
});

function renderAuth() {
  const area = $('#auth-area');
  if (!state.user) {
    area.innerHTML = '<button class="btn primary small" data-action="signin">Sign in</button>';
    return;
  }
  const p = state.profile || {};
  area.innerHTML = `
    <span class="rep" title="Reputation">★ ${esc(p.reputation ?? 0)}</span>
    <button class="avatar-btn" data-action="go-me" aria-label="My profile">${avatarHtml(p, 30)}</button>`;
}

// ---------------------------------------------------------------- data
async function loadReports() {
  const cutoff = Timestamp.fromDate(monthsAgo(HISTORY_MONTHS));
  const q = query(
    collection(db, 'reports'),
    where('status', '==', 'visible'),
    where('observedAt', '>=', cutoff),
    orderBy('observedAt', 'desc'),
    limit(5000),
  );
  try {
    const snap = await getDocs(q);
    state.reports = snap.docs.map((d) => {
      const r = d.data();
      return { id: d.id, ...r, observedAt: toDate(r.observedAt) };
    });
  } catch (err) {
    console.error(err);
    toast(friendlyError(err));
  }
  state.loaded = true;
  renderMap();
  if ($('#view-trends').classList.contains('active')) renderTrends();
  refreshTownList();
}

function matches(r, months) {
  const f = state.filters;
  if (f.meal !== 'any' && r.meal !== f.meal) return false;
  if (f.venue !== 'all' && r.venueType !== f.venue) return false;
  if (months != null && r.observedAt < monthsAgo(months)) return false;
  return true;
}
const filtered = (months = state.filters.months) => state.reports.filter((r) => matches(r, months));

function aggregateTowns(list) {
  const groups = new Map();
  for (const r of list) {
    if (!groups.has(r.townKey)) groups.set(r.townKey, { key: r.townKey, names: {}, reports: [] });
    const g = groups.get(r.townKey);
    g.names[r.town] = (g.names[r.town] || 0) + 1;
    g.reports.push(r);
  }
  return [...groups.values()].map((g) => {
    const seed = TOWNS.find((t) => t.key === g.key);
    const name = seed?.name || Object.entries(g.names).sort((a, b) => b[1] - a[1])[0][0];
    return {
      key: g.key,
      name,
      n: g.reports.length,
      median: median(g.reports.map((r) => r.priceNpr)),
      elevation: median(g.reports.map((r) => r.elevation)),
      lat: seed?.lat ?? median(g.reports.map((r) => r.lat)),
      lng: seed?.lng ?? median(g.reports.map((r) => r.lng)),
      reports: g.reports,
    };
  });
}

function monthlySeries(list) {
  const byMonth = new Map();
  for (const r of list) {
    const d = r.observedAt;
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(r.priceNpr);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, prices]) => ({ x: new Date(`${k}-15T00:00:00`), y: median(prices), n: prices.length }));
}

function refreshTownList() {
  const names = new Set(TOWNS.map((t) => t.name));
  state.reports.forEach((r) => names.add(r.town));
  $('#town-list').innerHTML = [...names].sort().map((n) => `<option value="${esc(n)}">`).join('');
}

// ---------------------------------------------------------------- map
// Clean, low-detail basemap (CARTO Positron / Dark Matter) that follows the light/dark theme.
// CARTO needs a free key (carto.com/basemaps/apikey); without one we fall back to standard OSM
// tiles rather than showing CARTO's "API key required" watermark.
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
function baseLayer() {
  if (!cartoKey) {
    return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 16, attribution: OSM_ATTR, crossOrigin: true });
  }
  const style = darkQuery.matches ? 'dark_all' : 'light_all';
  return L.tileLayer(`https://basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}.png?key=${encodeURIComponent(cartoKey)}`, {
    maxZoom: 16,
    crossOrigin: true, // CORS tiles can be cached efficiently by the service worker for offline use
    attribution: `${OSM_ATTR} &copy; <a href="https://carto.com/attributions">CARTO</a>`,
  });
}
// Keep the view on Nepal: a little padding around the border, no zooming out to the world.
const NEPAL_VIEW_LIMIT = L.latLngBounds(NEPAL_BOUNDS).pad(0.35);
const map = L.map('map', {
  zoomControl: true, attributionControl: true, zoomSnap: 0.25,
  minZoom: 6, maxBounds: NEPAL_VIEW_LIMIT, maxBoundsViscosity: 0.8,
}).fitBounds(NEPAL_BOUNDS, { padding: [10, 10] });
let mainTiles = baseLayer().addTo(map);
darkQuery.addEventListener('change', () => {
  map.removeLayer(mainTiles);
  mainTiles = baseLayer().addTo(map);
});
const markerLayer = L.layerGroup().addTo(map);

const RAMP = [[253, 230, 138], [245, 158, 11], [194, 65, 12], [127, 29, 29]];
function rampColor(t) {
  t = Math.max(0, Math.min(1, t));
  const seg = t * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(seg));
  const f = seg - i;
  const c = RAMP[i].map((v, j) => Math.round(v + (RAMP[i + 1][j] - v) * f));
  return `rgb(${c.join(',')})`;
}

function renderMap() {
  markerLayer.clearLayers();
  const list = filtered();
  const towns = aggregateTowns(list).filter((t) => t.lat != null);
  const meds = towns.map((t) => t.median).sort((a, b) => a - b);
  const lo = meds.length ? meds[Math.floor(meds.length * 0.1)] : 0;
  const hi = meds.length ? meds[Math.floor(meds.length * 0.9)] || meds[meds.length - 1] : 1;

  for (const t of towns) {
    const color = rampColor(hi > lo ? (t.median - lo) / (hi - lo) : 0.5);
    const dark = hi > lo && (t.median - lo) / (hi - lo) > 0.55;
    const icon = L.divIcon({
      className: '',
      html: `<div class="pin" style="background:${color};color:${dark ? '#fff' : '#2a2118'}">${Math.round(t.median)}</div>`,
      iconSize: null,
    });
    L.marker([t.lat, t.lng], { icon, title: `${t.name}: ${fmtRs(t.median)} (${t.n})` })
      .on('click', () => openTown(t.key))
      .addTo(markerLayer);
  }

  const nat = median(list.map((r) => r.priceNpr));
  $('#map-summary').innerHTML = list.length
    ? `National median <b>${fmtRs(nat)}</b> · ${list.length} reports · ${towns.length} towns`
    : state.loaded ? 'No prices yet for these filters — be the first! ＋' : 'Loading prices…';
  $('#legend').innerHTML = towns.length > 1
    ? `<div>Median plate price</div><div class="bar"></div><div class="ends"><span>${fmtRs(lo)}</span><span>${fmtRs(hi)}</span></div>`
    : '';
  $('#legend').hidden = towns.length <= 1;
}

// ---------------------------------------------------------------- trends
let tableSort = { key: 'median', dir: -1 };
function renderTrends() {
  const list = filtered();
  const towns = aggregateTowns(list);
  const withElev = towns.filter((t) => t.elevation != null);
  const points = withElev.map((t) => ({
    x: t.elevation, y: t.median, r: Math.min(14, 4 + Math.sqrt(t.n) * 1.5),
    label: `${t.name}: ${fmtRs(t.median)} at ${fmtM(t.elevation)} (${t.n} reports)`,
    onClick: () => openTown(t.key),
  }));
  scatterChart($('#chart-elev'), points, {
    xLabel: 'Elevation (m)', yLabel: 'Median price (Rs)', fmtY: (v) => v, fmtX: (v) => v.toLocaleString(),
  });
  const fit = linearFit(points);
  $('#elev-note').textContent = fit && points.length >= 3
    ? `Each dot is a town. Dashed line: about ${fmtRs(fit.b * 1000)} ${fit.b >= 0 ? 'more' : 'less'} per 1,000 m of climb (simple linear fit, ${points.length} towns).`
    : 'Each dot is a town: its median plate price against the median elevation of its reports.';

  lineChart($('#chart-time'), monthlySeries(filtered(HISTORY_MONTHS)), { yLabel: 'Median price (Rs)', fmtY: (v) => v });

  const sorted = [...towns].sort((a, b) => {
    const k = tableSort.key;
    const av = a[k] ?? -Infinity, bv = b[k] ?? -Infinity;
    return (typeof av === 'string' ? av.localeCompare(bv) : av - bv) * tableSort.dir;
  });
  $('#town-table').innerHTML = sorted.length ? `
    <table>
      <thead><tr>
        <th data-sort="name">Town</th><th class="num" data-sort="median">Median</th>
        <th class="num" data-sort="elevation">Elevation</th><th class="num" data-sort="n">Reports</th>
      </tr></thead>
      <tbody>${sorted.map((t) => `
        <tr class="clickable" data-town="${esc(t.key)}">
          <td>${esc(t.name)}</td><td class="num">${fmtRs(t.median)}</td>
          <td class="num">${fmtM(t.elevation)}</td><td class="num">${t.n}</td>
        </tr>`).join('')}</tbody>
    </table>` : '<p class="empty">No reports for these filters yet.</p>';
}
$('#town-table').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-sort]');
  if (th) {
    const k = th.dataset.sort;
    tableSort = { key: k, dir: tableSort.key === k ? -tableSort.dir : (k === 'name' ? 1 : -1) };
    renderTrends();
    return;
  }
  const tr = e.target.closest('tr[data-town]');
  if (tr) openTown(tr.dataset.town);
});

// ---------------------------------------------------------------- filters
for (const [id, key] of [['#f-meal', 'meal'], ['#f-venue', 'venue'], ['#f-months', 'months']]) {
  $(id).addEventListener('change', (e) => {
    state.filters[key] = key === 'months' ? Number(e.target.value) : e.target.value;
    renderMap();
    if ($('#view-trends').classList.contains('active')) renderTrends();
  });
}

// ---------------------------------------------------------------- town sheet
const sheet = $('#sheet');
function openSheet(html) {
  $('#sheet-body').innerHTML = html;
  if (!sheet.open) sheet.showModal();
}
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });

async function openTown(key) {
  const town = aggregateTowns(filtered()).find((t) => t.key === key)
    || aggregateTowns(filtered(HISTORY_MONTHS)).find((t) => t.key === key);
  if (!town) return;
  const f = state.filters;
  const history = state.reports.filter((r) => r.townKey === key && matches(r, HISTORY_MONTHS));
  const recent = [...town.reports].sort((a, b) => b.observedAt - a.observedAt).slice(0, 30);

  openSheet(`
    <h2 data-town="${esc(town.key)}">${esc(town.name)}</h2>
    <p class="muted small">${esc(f.meal === 'any' ? 'Any plate' : MEAL_LABEL[f.meal] + ' plate')} ·
      ${esc(f.venue === 'all' ? 'all places' : VENUE_LABEL[f.venue])} · last ${f.months} months</p>
    <div class="stats">
      <div class="stat"><b>${fmtRs(town.median)}</b><span>median</span></div>
      <div class="stat"><b>${town.n}</b><span>reports</span></div>
      <div class="stat"><b>${fmtM(town.elevation)}</b><span>elevation</span></div>
    </div>
    <div id="town-trend"></div>
    <h3>Latest reports</h3>
    <div id="town-reports">${recent.map(reportRow).join('')}</div>
  `);
  lineChart($('#town-trend'), monthlySeries(history), { yLabel: 'Rs', fmtY: (v) => v, height: 240 });
  hydrateReportRows(recent);
}

function reportRow(r) {
  const mine = state.user && r.uid === state.user.uid;
  return `
    <div class="report" data-report="${esc(r.id)}">
      <a href="${esc(photoUrl(r.photoPath))}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(photoUrl(r.photoPath))}" alt="Menu photo"></a>
      <div class="info">
        <div><span class="price-tag">${fmtRs(r.priceNpr)}</span> · ${esc(MEAL_LABEL[r.meal] || r.meal)} · ${esc(VENUE_LABEL[r.venueType] || r.venueType)}${r.refills ? ' · refills' : ''}</div>
        ${r.venueName ? `<div>${esc(r.venueName)}</div>` : ''}
        <div class="muted small">${fmtDate(r.observedAt)}${r.timeSource === 'exif' ? ' 📷' : ''}${r.elevation != null ? ` · ${fmtM(r.elevation)}` : ''} · <span class="by" data-action="profile" data-uid="${esc(r.uid)}">…</span></div>
        <div class="actions">
          ${mine ? '' : `<button class="icon-btn" data-action="confirm" data-id="${esc(r.id)}" title="I paid this too">✓ <span class="cc">${r.confirmCount || 0}</span></button>`}
          ${mine ? '' : `<button class="icon-btn" data-action="flag" data-type="reports" data-id="${esc(r.id)}">⚑ Flag</button>`}
          ${mine ? `<button class="icon-btn" data-action="delete" data-type="reports" data-id="${esc(r.id)}">🗑 Delete</button>` : ''}
        </div>
      </div>
    </div>`;
}

// ---- elevation: set server-side a few seconds after a report is created ----
const elevationRequested = new Set();

function applyElevation(id, elevation, townKeyToRefresh) {
  const r = state.reports.find((x) => x.id === id);
  if (!r || typeof elevation !== 'number') return;
  r.elevation = elevation;
  r.elevationPreview = false;
  renderMap();
  if ($('#view-trends').classList.contains('active')) renderTrends();
  if (sheet.open && townKeyToRefresh && $('#sheet-body h2')?.dataset.town === townKeyToRefresh) openTown(townKeyToRefresh);
}

/** Poll a just-created report until the server fills in its elevation, then ask it to retry. */
async function waitForElevation(id, key) {
  for (let i = 0; i < 6; i++) {
    await new Promise((res) => setTimeout(res, 2500));
    const snap = await getDoc(doc(db, 'reports', id)).catch(() => null);
    const elev = snap?.data()?.elevation;
    if (typeof elev === 'number') return applyElevation(id, elev, key);
  }
  ensureElevation({ id, townKey: key }, true);
}

/** Ask the server to look up elevation for a report that's missing it (once per session). */
async function ensureElevation(r, force = false) {
  if (!state.user || (typeof r.elevation === 'number' && !r.elevationPreview) || elevationRequested.has(r.id)) return;
  const ageMs = r.createdAt?.toMillis ? Date.now() - r.createdAt.toMillis() : Infinity;
  if (!force && ageMs < 30000) return; // creation trigger may still be running
  elevationRequested.add(r.id);
  try {
    const { data } = await fillElevationFn({ reportId: r.id });
    applyElevation(r.id, data?.elevation, r.townKey);
  } catch (err) {
    console.warn('fillElevation failed', err);
  }
}

async function hydrateReportRows(reports) {
  reports.forEach((r) => ensureElevation(r));
  await Promise.all(reports.map(async (r) => {
    const row = $(`.report[data-report="${CSS.escape(r.id)}"]`);
    if (!row) return;
    const u = await getUserInfo(r.uid);
    const by = $('.by', row);
    if (by) by.innerHTML = userLabel(u);
    if (state.user && r.uid !== state.user.uid) {
      const c = await getDoc(doc(db, 'reports', r.id, 'confirms', state.user.uid)).catch(() => null);
      if (c?.exists()) $('[data-action="confirm"]', row)?.classList.add('on');
    }
  }));
}

async function toggleConfirm(btn) {
  if (!state.user) return signIn();
  const id = btn.dataset.id;
  const ref = doc(db, 'reports', id, 'confirms', state.user.uid);
  const cc = $('.cc', btn);
  const on = btn.classList.contains('on');
  btn.disabled = true;
  try {
    if (on) await deleteDoc(ref);
    else await setDoc(ref, { createdAt: serverTimestamp() });
    btn.classList.toggle('on', !on);
    cc.textContent = Math.max(0, Number(cc.textContent) + (on ? -1 : 1));
    const r = state.reports.find((x) => x.id === id);
    if (r) r.confirmCount = Number(cc.textContent);
  } catch (err) {
    toast(friendlyError(err));
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- flagging
function openFlag(type, id) {
  if (!state.user) return signIn();
  openSheet(`
    <h2>Flag this ${type === 'reports' ? 'price report' : 'post'}</h2>
    <p class="muted small">Flags from members with more reputation count for more. Enough flags hide the item until a moderator reviews it.</p>
    <form id="flag-form" class="form" data-type="${esc(type)}" data-id="${esc(id)}">
      ${Object.entries(FLAG_REASONS).map(([k, v], i) => `
        <label class="check"><input type="radio" name="reason" value="${k}" ${i === 0 ? 'checked' : ''}> ${esc(v)}</label>`).join('')}
      <label>Details (optional)<textarea name="note" maxlength="200" rows="2"></textarea></label>
      <button class="btn primary wide" type="submit" style="margin-top:12px">Send flag</button>
    </form>`);
}

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'flag-form') return;
  e.preventDefault();
  const form = e.target;
  const { type, id } = form.dataset;
  const fd = new FormData(form);
  try {
    await setDoc(doc(db, 'flags', `${type}__${id}__${state.user.uid}`), {
      uid: state.user.uid,
      targetType: type,
      targetId: id,
      reason: fd.get('reason'),
      note: String(fd.get('note') || '').slice(0, 200),
      createdAt: serverTimestamp(),
    });
    sheet.close();
    toast('Thanks — flag sent.');
  } catch (err) {
    toast(err?.code === 'permission-denied' ? "You've already flagged this (or can't flag your own)." : friendlyError(err));
  }
});

// ---------------------------------------------------------------- feed
async function loadFeed(reset = false) {
  if (state.feedLoading) return;
  if (reset) { state.feedCursor = null; state.feedDone = false; $('#feed').innerHTML = ''; }
  if (state.feedDone) return;
  state.feedLoading = true;
  const parts = [collection(db, 'posts'), where('status', '==', 'visible'), orderBy('createdAt', 'desc')];
  if (state.feedCursor) parts.push(startAfter(state.feedCursor));
  parts.push(limit(12));
  try {
    const snap = await getDocs(query(...parts));
    if (snap.docs.length < 12) state.feedDone = true;
    state.feedCursor = snap.docs[snap.docs.length - 1] || state.feedCursor;
    const posts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    $('#feed').insertAdjacentHTML('beforeend', posts.map(postCard).join(''));
    if (reset && !posts.length) $('#feed').innerHTML = '<p class="empty">No dal bhat posted yet. Tap ＋ to share yours.</p>';
    hydratePosts(posts);
  } catch (err) {
    console.error(err);
    toast(friendlyError(err));
  } finally {
    state.feedLoading = false;
    $('#feed-more').hidden = state.feedDone;
  }
}
$('#feed-more').addEventListener('click', () => loadFeed());

function postCard(p) {
  const mine = state.user && p.uid === state.user.uid;
  return `
    <article class="post" data-post="${esc(p.id)}">
      <div class="post-head">
        <img class="avatar" alt="" referrerpolicy="no-referrer" hidden>
        <div class="who"><b class="name" data-action="profile" data-uid="${esc(p.uid)}">…</b><span class="muted small">${esc(p.town)} · ${fmtDate(p.createdAt)}</span></div>
        ${p.priceNpr ? `<span class="price-tag">${fmtRs(p.priceNpr)}</span>` : ''}
      </div>
      <img class="post-img" loading="lazy" src="${esc(photoUrl(p.photoPath))}" alt="Dal bhat in ${esc(p.town)}">
      ${p.caption ? `<div class="post-body">${esc(p.caption)}</div>` : ''}
      <div class="post-actions">
        ${mine ? `<span class="muted small">♥ ${p.likeCount || 0}</span>`
          : `<button class="icon-btn" data-action="like" data-id="${esc(p.id)}">♥ <span class="lc">${p.likeCount || 0}</span></button>`}
        <span class="spacer"></span>
        ${mine ? `<button class="icon-btn" data-action="delete" data-type="posts" data-id="${esc(p.id)}">🗑</button>`
          : `<button class="icon-btn" data-action="flag" data-type="posts" data-id="${esc(p.id)}">⚑</button>`}
      </div>
    </article>`;
}

async function hydratePosts(posts) {
  await Promise.all(posts.map(async (p) => {
    const card = $(`.post[data-post="${CSS.escape(p.id)}"]`);
    if (!card) return;
    const u = await getUserInfo(p.uid);
    $('.name', card).innerHTML = userLabel(u);
    if (u.photoURL) { const a = $('.avatar', card); a.src = u.photoURL; a.hidden = false; }
    if (state.user && p.uid !== state.user.uid) {
      const l = await getDoc(doc(db, 'posts', p.id, 'likes', state.user.uid)).catch(() => null);
      if (l?.exists()) $('[data-action="like"]', card)?.classList.add('on');
    }
  }));
}

async function toggleLike(btn) {
  if (!state.user) return signIn();
  const ref = doc(db, 'posts', btn.dataset.id, 'likes', state.user.uid);
  const lc = $('.lc', btn);
  const on = btn.classList.contains('on');
  btn.disabled = true;
  try {
    if (on) await deleteDoc(ref);
    else await setDoc(ref, { createdAt: serverTimestamp() });
    btn.classList.toggle('on', !on);
    lc.textContent = Math.max(0, Number(lc.textContent) + (on ? -1 : 1));
  } catch (err) {
    toast(friendlyError(err));
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- add: forms
$$('.seg').forEach((b) => b.addEventListener('click', () => {
  $$('.seg').forEach((x) => x.classList.toggle('active', x === b));
  $('#form-report').hidden = b.dataset.form !== 'report';
  $('#form-post').hidden = b.dataset.form !== 'post';
  if (b.dataset.form === 'report') setTimeout(initMiniMap, 50);
}));

const draft = { meta: null, lat: null, lng: null, geoSource: null, townAuto: true, elevation: null };
let miniMap, miniMarker;

function initMiniMap() {
  if ($('#form-report').hidden || !$('#view-add').classList.contains('active') || !state.user) return;
  if (miniMap) { miniMap.invalidateSize(); return; }
  miniMap = L.map('r-map', { minZoom: 6, maxBounds: NEPAL_VIEW_LIMIT }).fitBounds(NEPAL_BOUNDS);
  baseLayer().addTo(miniMap);
  miniMap.on('click', (e) => setLocation(e.latlng.lat, e.latlng.lng, 'map'));
  if (draft.lat != null) setLocation(draft.lat, draft.lng, draft.geoSource);
}

// ---- plates (one submission can price several dal bhat sets from the same menu) ----
function plateRow(meal) {
  const div = document.createElement('div');
  div.className = 'plate-row';
  div.innerHTML = `
    <select class="plate-meal" aria-label="Plate">
      ${Object.entries(MEAL_LABEL).map(([k, v]) => `<option value="${k}" ${k === meal ? 'selected' : ''}>${v}</option>`).join('')}
    </select>
    <input type="number" class="plate-price" inputmode="numeric" min="30" max="5000" step="1" placeholder="—" aria-label="Price in rupees" />
    <button type="button" class="remove" aria-label="Remove plate">✕</button>`;
  $('.remove', div).addEventListener('click', () => {
    div.remove();
    if (!$$('#r-plates .plate-row').length) $('#r-plates').appendChild(plateRow('veg'));
    $('#r-add-plate').hidden = false;
  });
  return div;
}
function resetPlates() {
  const box = $('#r-plates');
  box.innerHTML = '';
  DEFAULT_PLATES.forEach((m) => box.appendChild(plateRow(m)));
  $('#r-add-plate').hidden = false;
}
$('#r-add-plate').addEventListener('click', () => {
  const used = $$('#r-plates .plate-meal').map((s) => s.value);
  const next = Object.keys(MEAL_LABEL).find((m) => !used.includes(m)) || 'other';
  const row = plateRow(next);
  $('#r-plates').appendChild(row);
  $('.plate-price', row).focus();
  $('#r-add-plate').hidden = $$('#r-plates .plate-row').length >= MAX_PLATES;
});
resetPlates();

/** Read filled-in plates; returns {plates} or {error}. */
function readPlates() {
  const plates = [];
  for (const row of $$('#r-plates .plate-row')) {
    const raw = $('.plate-price', row).value.trim();
    if (raw === '') continue;
    const price = Number(raw);
    const meal = $('.plate-meal', row).value;
    if (!Number.isInteger(price) || price < 30 || price > 5000) {
      return { error: `${MEAL_LABEL[meal]} price should be a whole number between 30 and 5000.` };
    }
    plates.push({ meal, price });
  }
  if (!plates.length) return { error: 'Enter the price of at least one plate.' };
  return { plates };
}

// ---- elevation preview in the browser (the server stores the official value) ----
let elevPreviewTimer;
let elevPreviewAbort;
function previewElevation(lat, lng) {
  draft.elevation = null;
  clearTimeout(elevPreviewTimer);
  elevPreviewTimer = setTimeout(async () => {
    if (elevPreviewAbort) elevPreviewAbort.abort();
    elevPreviewAbort = new AbortController();
    try {
      const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat.toFixed(5)}&longitude=${lng.toFixed(5)}`, { signal: elevPreviewAbort.signal });
      const m = (await res.json())?.elevation?.[0];
      if (typeof m === 'number' && draft.lat === lat && draft.lng === lng) {
        draft.elevation = Math.round(m);
        $('#r-elev').textContent = ` · ⛰ ${fmtM(draft.elevation)}`;
      }
    } catch { /* preview only */ }
  }, 300);
}

function setLocation(lat, lng, source) {
  if (!inNepal(lat, lng)) { toast('That location is outside Nepal.'); return; }
  draft.lat = lat; draft.lng = lng; draft.geoSource = source;
  $('#r-elev').textContent = '';
  previewElevation(lat, lng);
  if (miniMap) {
    if (!miniMarker) {
      miniMarker = L.marker([lat, lng], { draggable: true }).addTo(miniMap);
      miniMarker.on('dragend', () => {
        const p = miniMarker.getLatLng();
        setLocation(p.lat, p.lng, 'map');
      });
    } else {
      miniMarker.setLatLng([lat, lng]);
    }
    miniMap.setView([lat, lng], Math.max(miniMap.getZoom(), 13));
  }
  const near = nearestTown(lat, lng);
  if (near && (draft.townAuto || !$('#r-town').value)) {
    $('#r-town').value = near.name;
    draft.townAuto = true;
  }
}
// ---- town / village search (known towns first, then OpenStreetMap Nominatim) ----
const townInput = $('#r-town');
const suggestBox = $('#r-town-suggest');
let suggestItems = [];
let suggestIndex = -1;
let geocodeTimer;
let geocodeAbort;

function knownPlaces() {
  const places = new Map(TOWNS.map((t) => [t.key, { name: t.name, lat: t.lat, lng: t.lng, detail: 'Known town' }]));
  for (const t of aggregateTowns(state.reports)) {
    if (!places.has(t.key) && t.lat != null) {
      places.set(t.key, { name: t.name, lat: t.lat, lng: t.lng, detail: `${t.n} report${t.n === 1 ? '' : 's'}` });
    }
  }
  return [...places.values()];
}

function localMatches(q) {
  const needle = q.toLowerCase();
  return knownPlaces()
    .map((p) => ({ p, i: p.name.toLowerCase().indexOf(needle) }))
    .filter((x) => x.i >= 0)
    .sort((a, b) => a.i - b.i || a.p.name.localeCompare(b.p.name))
    .slice(0, 5)
    .map((x) => x.p);
}

function renderSuggest(items, note) {
  suggestItems = items;
  suggestIndex = items.length ? 0 : -1;
  suggestBox.innerHTML = items.map((p, i) => `
    <li role="option" data-i="${i}" class="${i === 0 ? 'active' : ''}">${p.settlement === false ? '🏷 ' : ''}${esc(p.name)}<small>${esc(p.detail || '')}</small></li>`).join('')
    + (note ? `<li class="note">${esc(note)}</li>` : '');
  const show = items.length > 0 || !!note;
  suggestBox.hidden = !show;
  townInput.setAttribute('aria-expanded', String(show));
}

// Trekking villages are spelled many ways; OpenStreetMap usually has just one of them.
const SPELLING_VARIANTS = [
  ['gho', 'goa', 'gowa'], ['bimthang', 'bhimthang'], ['tilije', 'tilche', 'tilje'],
  ['samagaun', 'samagaon', 'sama gaun'], ['dharamsala', 'dharmasala', 'larkya phedi', 'larke phedi'],
  ['machha khola', 'machhakhola', 'macchha khola'], ['soti khola', 'sotikhola'],
  ['thorong phedi', 'thorung phedi'], ['chhomrong', 'chomrong'], ['jhinu danda', 'jhinu'],
  ['lobuche', 'lobuje'], ['gorak shep', 'gorakshep'], ['tengboche', 'thyangboche'],
  ['namche bazaar', 'namche bazar', 'namche'], ['syabrubesi', 'syabru besi'],
  ['kyanjin gompa', 'kyangjin gompa', 'kyanjin'], ['ghorepani', 'ghorapani'], ['muktinath', 'mukti nath'],
];

function cleanQuery(q) {
  return q.replace(/,?\s*nepal\s*$/i, '').replace(/\s+/g, ' ').trim();
}

function queryVariants(q) {
  const base = cleanQuery(q);
  const key = base.toLowerCase();
  const group = SPELLING_VARIANTS.find((g) => g.includes(key));
  return [base, ...(group ? group.filter((v) => v !== key) : [])].slice(0, 3);
}

const SETTLEMENT_TYPES = new Set(['city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood', 'quarter',
  'locality', 'isolated_dwelling', 'municipality', 'county', 'state_district']);
const pause = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); });
});

async function nominatim(params, signal) {
  const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
    format: 'jsonv2', countrycodes: 'np', limit: '8', 'accept-language': 'en', ...params,
  });
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  return (await res.json()).map((r) => {
    const settlement = r.category === 'place' || SETTLEMENT_TYPES.has(r.addresstype);
    const area = r.display_name.split(',').slice(1, 3).join(',').trim();
    const kind = settlement ? '' : `${String(r.type || r.category).replace(/_/g, ' ')} · `;
    return {
      name: (r.name || r.display_name.split(',')[0]).slice(0, 60),
      lat: Number(r.lat),
      lng: Number(r.lon),
      settlement,
      detail: kind + area,
    };
  }).filter((p) => p.name && inNepal(p.lat, p.lng));
}

/**
 * Villages and towns first (trying common spelling variants), then — only if none — anything
 * else OpenStreetMap knows by that name (hotels, shops…), clearly labelled.
 * Requests are spaced ≥1 s apart to respect Nominatim's usage policy.
 */
async function geocode(q) {
  if (geocodeAbort) geocodeAbort.abort();
  geocodeAbort = new AbortController();
  const { signal } = geocodeAbort;
  const variants = queryVariants(q);
  const places = [];
  for (let i = 0; i < variants.length; i++) {
    if (i) await pause(1100, signal);
    places.push(...await nominatim({ q: variants[i], featureType: 'settlement' }, signal));
    if (places.length >= 3) break;
  }
  if (!places.length) {
    if (variants.length) await pause(1100, signal);
    places.push(...await nominatim({ q: variants[0] }, signal));
  }
  // Same name can be two different villages (e.g. Jagat): de-dupe by name + rough position.
  const seen = new Set();
  return places
    .sort((a, b) => b.settlement - a.settlement)
    .filter((p) => {
      const k = `${townKey(p.name)}@${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;
      return !seen.has(k) && seen.add(k);
    });
}
townInput.addEventListener('input', () => {
  draft.townAuto = false;
  const q = townInput.value.trim();
  clearTimeout(geocodeTimer);
  if (q.length < 2) { renderSuggest([]); return; }
  const local = localMatches(q);
  // Typing a known town's full name moves the pin straight away.
  const exact = local.find((p) => townKey(p.name) === townKey(q));
  if (exact) applyPlace(exact);
  renderSuggest(local, q.length >= 3 ? 'Searching map…' : null);
  if (q.length < 3) return;
  geocodeTimer = setTimeout(async () => {
    try {
      const remote = await geocode(q);
      if (townInput.value.trim() !== q) return; // user kept typing
      const localKeys = new Set(local.map((p) => townKey(p.name)));
      const merged = [...local, ...remote.filter((p) => !localKeys.has(townKey(p.name)))];
      renderSuggest(merged.slice(0, 8), merged.length
        ? (merged.some((p) => p.settlement !== false) ? null : 'No village by that name — pick a nearby one and drag the pin, or tap the map')
        : 'Not found — keep the name, and tap the map (or pick a nearby village and drag the pin)');
    } catch (err) {
      if (err.name !== 'AbortError') renderSuggest(local, local.length ? null : "Couldn't search right now — tap the map instead");
    }
  }, 600); // Nominatim asks for ≤1 request/second
});

function pickSuggestion(i) {
  const p = suggestItems[i];
  if (!p) return;
  townInput.value = p.name;
  renderSuggest([]);
  applyPlace(p);
}

/** When the user leaves the field without picking, use the best match for what they typed. */
async function resolveTypedTown() {
  const q = townInput.value.trim();
  if (q.length < 2) return;
  const key = townKey(cleanQuery(q));
  const local = knownPlaces().find((p) => townKey(p.name) === key);
  if (local) return applyPlace(local);
  if (draft.lat != null) return; // never move a pin the user (or their photo) already set
  try {
    const results = await geocode(q);
    if (townInput.value.trim() !== q) return;
    // Only auto-place on an unambiguous village/town match; otherwise let the user choose.
    const variants = new Set(queryVariants(q).map(townKey));
    const exact = results.filter((p) => p.settlement && variants.has(townKey(p.name)));
    if (exact.length === 1) {
      applyPlace(exact[0], `Pin set to ${exact[0].name} (${exact[0].detail}) — drag it if that's not right`);
    } else {
      $('#r-loc-status').textContent = results.length
        ? 'Pick the right place from the list, or tap the map'
        : 'Not found on the map — keep the name and tap the map to set the spot';
      if (results.length) { townInput.focus(); renderSuggest(results.slice(0, 8)); }
    }
  } catch { /* ignore; user can tap the map */ }
}
townInput.addEventListener('change', resolveTypedTown);

suggestBox.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  e.preventDefault(); // keep focus so blur doesn't close the list first
  pickSuggestion(Number(li.dataset.i));
});

townInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (suggestBox.hidden || !suggestItems.length)) {
    e.preventDefault(); // don't submit the form; just place the pin
    resolveTypedTown();
    return;
  }
  if (suggestBox.hidden || !suggestItems.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    suggestIndex = (suggestIndex + (e.key === 'ArrowDown' ? 1 : -1) + suggestItems.length) % suggestItems.length;
    $$('li[data-i]', suggestBox).forEach((li, i) => li.classList.toggle('active', i === suggestIndex));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    pickSuggestion(Math.max(0, suggestIndex));
  } else if (e.key === 'Escape') {
    renderSuggest([]);
  }
});
townInput.addEventListener('blur', () => setTimeout(() => renderSuggest([]), 150));

$('#r-use-device').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Location not available on this device.');
  navigator.geolocation.getCurrentPosition(
    (pos) => setLocation(pos.coords.latitude, pos.coords.longitude, 'device'),
    (err) => { lastGpsError = err.code; gpsHelp(true); },
    { enableHighAccuracy: true, timeout: 10000 },
  );
});

// ---- choosing / taking the menu photo ----
const selected = { r: null, p: null };

// GPS for in-app photos: phones strip location from photos chosen on websites, so when the
// photo is taken here we record the phone's own GPS fix (works without signal) and the time.
let gpsWatch = null;
let gpsStopTimer;
let lastFix = null;
let lastGpsError = null; // GeolocationPositionError code: 1 denied, 2 unavailable, 3 timeout

function recordFix(pos) {
  lastFix = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, at: Date.now() };
  lastGpsError = null;
}
function startGps() {
  if (!navigator.geolocation) return;
  clearTimeout(gpsStopTimer);
  gpsStopTimer = setTimeout(stopGps, 5 * 60 * 1000);
  if (gpsWatch != null) return;
  gpsWatch = navigator.geolocation.watchPosition(recordFix, (err) => { lastGpsError = err.code; },
    { enableHighAccuracy: true, maximumAge: 30000, timeout: 60000 });
}
function stopGps() {
  if (gpsWatch != null) navigator.geolocation.clearWatch(gpsWatch);
  gpsWatch = null;
}
function getFixOnce(timeout = 15000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => { recordFix(pos); resolve(lastFix); },
      (err) => { lastGpsError = err.code; resolve(null); },
      { enableHighAccuracy: true, maximumAge: 60000, timeout },
    );
  });
}
async function gpsPermission() {
  try { return (await navigator.permissions.query({ name: 'geolocation' })).state; } catch { return 'unknown'; }
}
const fixIsFresh = () => lastFix && Date.now() - lastFix.at < 3 * 60 * 1000 && lastFix.acc < 2000;
async function waitForFix(ms = 15000) {
  if (fixIsFresh()) return lastFix;
  // Android may pause the GPS watch while the camera app is in front, so ask again directly.
  const once = getFixOnce(ms);
  const t0 = Date.now();
  while (!fixIsFresh() && lastGpsError !== 1 && Date.now() - t0 < ms) await new Promise((res) => setTimeout(res, 500));
  if (!fixIsFresh()) await Promise.race([once, new Promise((res) => setTimeout(res, 1000))]);
  return fixIsFresh() ? lastFix : null;
}

function gpsHelp(show) {
  const box = $('#gps-help');
  if (!show) { box.hidden = true; return; }
  const android = /android/i.test(navigator.userAgent);
  const reason = {
    1: 'Location is blocked for this site.',
    2: "Your phone couldn't get a location — is Location turned on?",
    3: 'GPS took too long — step outside or near a window and try again.',
  }[lastGpsError] || "We couldn't get your location.";
  const fix = lastGpsError === 1
    ? (android
      ? 'To allow it: Android Settings → Location must be on, and Settings → Apps → Chrome → Permissions → Location → "Allow while using the app". Then in Chrome open this site → tap the icon left of the address (or ⋮ → Site settings) → Location → Allow.'
      : 'To allow it: Settings → Privacy & Security → Location Services → Safari Websites → "While Using the App", then reload.')
    : 'You can also tap the map or search for the village below.';
  box.textContent = `📍 ${reason} ${fix}`;
  box.hidden = false;
}

// "Take photo": make sure we can read GPS *before* the camera covers the screen. If Chrome's
// location prompt opens at the same moment as the camera it gets dismissed, and repeated
// dismissals make Chrome block location for the site.
$('#r-camera-btn').addEventListener('click', async () => {
  const input = $('#r-camera');
  const perm = await gpsPermission();
  if (perm === 'granted') {
    startGps();
    getFixOnce();
    gpsHelp(false);
    input.click();
    return;
  }
  if (perm === 'denied') {
    lastGpsError = 1;
    gpsHelp(true);
    input.click(); // still let them take the photo; they can place the pin by hand
    return;
  }
  // 'prompt' / unknown: ask for location first, then open the camera.
  toast('First, allow location so your photo gets tagged with where you are.');
  const btn = $('#r-camera-btn');
  btn.disabled = true;
  const fix = await getFixOnce(20000);
  btn.disabled = false;
  if (fix || lastGpsError !== 1) startGps();
  gpsHelp(!fix);
  if (fix) toast('📍 Location on — opening camera…');
  input.click(); // may be ignored if the prompt took a while; then tap Take photo again
});

// Warm up GPS as soon as the Add screen opens (only if already allowed — never prompt here).
async function warmGps() {
  if ((await gpsPermission()) === 'granted') { startGps(); getFixOnce(); }
}

/**
 * Copy a picked photo into memory straight away. On Android the browser's permission to read
 * a picked file can lapse (e.g. while you type a caption or the app is in the background),
 * after which every read fails — so never rely on the original File later.
 */
async function snapshotFile(file) {
  if (!file) return null;
  try {
    const buf = await file.arrayBuffer();
    return new File([buf], file.name || 'photo.jpg', { type: file.type, lastModified: file.lastModified });
  } catch (err) {
    console.error('Could not read picked file', err);
    toast("Couldn't open that photo — please pick it again.");
    return null;
  }
}

async function handleMenuPhoto(picked, fromCamera) {
  const chips = $('#r-meta');
  chips.innerHTML = '';
  clearPreview('r');
  selected.r = null;
  const file = await snapshotFile(picked);
  selected.r = file;
  if (!file) return;
  showPreview(file, $('#r-preview'));
  const meta = await readPhotoMeta(file);
  draft.meta = meta;
  const out = [];
  if (meta.takenAt) {
    draft.takenAt = meta.takenAt;
    draft.timeSource = 'exif';
    out.push(`<span class="chip">🕒 Taken ${esc(meta.takenAt.toLocaleString())}</span>`);
    const days = (Date.now() - meta.takenAt) / 86400000;
    if (days > 60) out.push(`<span class="chip warn">Photo is ${Math.round(days)} days old — it'll be dated then</span>`);
  } else if (fromCamera) {
    draft.takenAt = new Date();
    draft.timeSource = 'device';
    out.push(`<span class="chip">🕒 Taken ${esc(draft.takenAt.toLocaleString())}</span>`);
  } else {
    draft.takenAt = null;
    draft.timeSource = 'upload';
    out.push('<span class="chip warn">No timestamp in photo — using upload time</span>');
  }
  chips.innerHTML = out.join('');

  if (meta.lat != null) {
    out.push('<span class="chip">📍 Location from photo</span>');
    setLocation(meta.lat, meta.lng, 'exif');
  } else if (fromCamera) {
    chips.innerHTML = out.join('') + '<span class="chip" id="gps-chip">📍 Getting GPS fix…</span>';
    const fix = await waitForFix();
    if (selected.r !== file) return; // user picked another photo meanwhile
    if (fix && inNepal(fix.lat, fix.lng)) {
      out.push(`<span class="chip">📍 Phone GPS (±${Math.round(fix.acc)} m)</span>`);
      gpsHelp(false);
      setLocation(fix.lat, fix.lng, 'device');
    } else if (fix) {
      out.push('<span class="chip warn">GPS says you\'re outside Nepal — set the spot below</span>');
    } else {
      out.push('<span class="chip warn">No GPS fix — set the spot below</span>');
      gpsHelp(true);
    }
  } else if (meta.gpsOutsideNepal) {
    out.push('<span class="chip warn">This photo was tagged outside Nepal — set the spot below</span>');
  } else {
    // Phones strip GPS from gallery photos given to websites. If the photo is recent and
    // location is allowed, you're probably still nearby — use the phone's location instead.
    const ageMin = meta.takenAt ? (Date.now() - meta.takenAt.getTime()) / 60000 : Infinity;
    const android = /android/i.test(navigator.userAgent);
    if (ageMin < 90 && (await gpsPermission()) === 'granted') {
      chips.innerHTML = out.join('') + '<span class="chip">📍 Getting your location…</span>';
      const fix = await getFixOnce(12000);
      if (selected.r !== file) return;
      if (fix && inNepal(fix.lat, fix.lng)) {
        setLocation(fix.lat, fix.lng, 'device');
        out.push(`<span class="chip">📍 Your current location (photo taken ${Math.max(1, Math.round(ageMin))} min ago) — drag the pin if you've moved</span>`);
      } else {
        out.push('<span class="chip warn">Unable to get location from this photo — set the spot below</span>');
      }
    } else if (android) {
      out.push('<span class="chip warn">Unable to get location from this photo (Android removes it from gallery photos) — set the spot below, or use 📷 Take photo next time</span>');
    } else if (isIOS) {
      out.push('<span class="chip warn">Unable to get location from this photo. Tip: when picking a photo, tap <b>Options</b> and turn on <b>Location</b></span>');
    } else {
      out.push('<span class="chip warn">Unable to get location from this photo — set the spot below</span>');
    }
  }
  chips.innerHTML = out.join('');
}
$('#r-camera').addEventListener('change', (e) => handleMenuPhoto(e.target.files[0], true));
$('#r-photo').addEventListener('change', (e) => handleMenuPhoto(e.target.files[0], false));

$('#p-photo').addEventListener('change', async (e) => {
  clearPreview('p');
  selected.p = null;
  const file = await snapshotFile(e.target.files[0]);
  selected.p = file;
  if (!file) return;
  showPreview(file, $('#p-preview'));
});

// ---- photo previews with rotation (menus on a table often come out sideways) ----
const rotation = { r: 0, p: 0 };
let previewSeq = 0;

/** Render a small, rotated preview (also converts iPhone HEIC where the browser can't show it). */
async function showPreview(file, img) {
  const k = img.id[0]; // 'r' or 'p'
  const seq = ++previewSeq;
  const timer = setTimeout(() => toast('Preparing photo…'), 500);
  try {
    const blob = await reencodeJpeg(file, { maxSide: 900, quality: 0.8, rotation: rotation[k] });
    if (seq !== previewSeq) return; // a newer rotate/click superseded this one
    if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
    img.dataset.url = URL.createObjectURL(blob);
    img.src = img.dataset.url;
    img.hidden = false;
    $(`#${k}-rotate`).hidden = false;
  } catch (err) {
    img.hidden = true;
    $(`#${k}-rotate`).hidden = true;
    toast(err.message || "Couldn't read this photo. Try a JPEG or PNG.");
  } finally {
    clearTimeout(timer);
  }
}

function clearPreview(k) {
  rotation[k] = 0;
  $(`#${k}-preview`).hidden = true;
  $(`#${k}-rotate`).hidden = true;
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-rotate]');
  if (!btn) return;
  const k = btn.dataset.rotate;
  const file = selected[k];
  if (!file) return;
  rotation[k] = (rotation[k] + Number(btn.dataset.dir) + 360) % 360;
  showPreview(file, $(`#${k}-preview`));
});

async function uploadPhoto(file, kind, opts = {}) {
  const blob = await reencodeJpeg(file, opts);
  if (blob.size > 3 * 1024 * 1024) throw new Error('Photo is too large even after resizing.');
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.jpg`;
  const path = `uploads/${state.user.uid}/${kind}/${name}`;
  await uploadBytes(storageRef(storage, path), blob, {
    contentType: 'image/jpeg',
    cacheControl: 'public, max-age=31536000, immutable', // photos never change; cache once per viewer
  });
  return path;
}

// ---- sending a price submission (now, or later from the offline queue) ----
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function isNetworkError(err) {
  const code = err?.code || '';
  return !navigator.onLine
    || ['storage/retry-limit-exceeded', 'storage/unknown', 'unavailable', 'deadline-exceeded'].includes(code)
    || err instanceof TypeError
    || /network|offline|fetch|timed? ?out/i.test(err?.message || '');
}

/** Upload the photo and write one report per plate. Returns {ids, townKey}. */
async function sendSubmission(item) {
  const name = `${item.localId}.jpg`;
  const path = `uploads/${state.user.uid}/menus/${name}`;
  await uploadBytes(storageRef(storage, path), item.blob, {
    contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable',
  });
  try {
    const f = item.fields;
    const shared = {
      uid: state.user.uid,
      town: f.town,
      townKey: f.townKey,
      lat: f.lat,
      lng: f.lng,
      geoSource: f.geoSource,
      venueType: f.venueType,
      venueName: f.venueName,
      refills: f.refills,
      photoPath: path,
      observedAt: f.observedAtMs ? Timestamp.fromMillis(f.observedAtMs) : serverTimestamp(),
      timeSource: f.timeSource,
      status: 'visible',
      flagScore: 0,
      confirmCount: 0,
      createdAt: serverTimestamp(),
    };
    const batch = writeBatch(db);
    const ids = item.plates.map((pl, i) => {
      const ref = doc(collection(db, 'reports'));
      batch.set(ref, { ...shared, meal: pl.meal, priceNpr: pl.price, plateIndex: i });
      return ref.id;
    });
    // With the offline cache, a commit made just as the signal drops is kept and sent later
    // by Firestore itself — so don't wait forever for the server's acknowledgement.
    await Promise.race([batch.commit(), sleep(20000)]);
    return { ids, townKey: f.townKey };
  } catch (err) {
    if (!isNetworkError(err)) deleteObject(storageRef(storage, path)).catch(() => {});
    throw err;
  }
}

$('#form-report').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.user) return signIn();
  const file = selected.r;
  const townName = $('#r-town').value.trim();
  if (!file) return toast('Add a photo of the menu.');
  const { plates, error } = readPlates();
  if (error) return toast(error);
  if (!townName) return toast('Which town or village is this?');
  if (draft.lat == null) {
    const known = knownPlaces().find((p) => townKey(p.name) === townKey(townName));
    if (known) setLocation(known.lat, known.lng, 'map');
  }
  if (draft.lat == null) return toast('Pick the town from the search list, use your location, or tap the map.');

  const btn = $('#r-submit');
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  try {
    const blob = await reencodeJpeg(file, { rotation: rotation.r });
    if (blob.size > 3 * 1024 * 1024) throw new Error('Photo is too large even after resizing.');
    const { town, townKey: key } = canonicalTown(townName);
    const now = Date.now();
    let timeSource = draft.timeSource || 'upload';
    let observedAtMs = draft.takenAt ? draft.takenAt.getTime() : null;
    const item = {
      localId: `${now}-${Math.random().toString(36).slice(2, 10)}`,
      uid: state.user.uid,
      queuedAt: now,
      blob,
      plates,
      fields: {
        town, townKey: key,
        lat: Number(draft.lat.toFixed(5)), lng: Number(draft.lng.toFixed(5)), geoSource: draft.geoSource,
        venueType: $('#r-venue').value,
        venueName: $('#r-venue-name').value.trim().slice(0, 80),
        refills: $('#r-refills').checked,
        observedAtMs, timeSource,
      },
    };
    const queueIt = async () => {
      // Sent later: "upload time" would be wrong, so record when it was submitted on the phone.
      if (!item.fields.observedAtMs) { item.fields.observedAtMs = now; item.fields.timeSource = 'device'; }
      await queuePut(item);
      toast('📴 Saved on your phone — it will upload automatically when you\'re back online.');
      resetReportForm();
      updateQueueStatus();
    };
    if (!navigator.onLine) return await queueIt();

    btn.textContent = 'Uploading…';
    let result;
    try {
      result = await sendSubmission(item);
    } catch (err) {
      if (isNetworkError(err)) return await queueIt();
      throw err;
    }
    const previewElev = draft.elevation;
    celebrate(5 + (plates.length - 1), `${plates.length} price${plates.length > 1 ? 's' : ''} added — thanks for helping fellow trekkers!`);
    resetReportForm();
    await loadReports();
    // Show elevation straight away from the browser's lookup; the server's value replaces it.
    for (const id of result.ids) {
      const r = state.reports.find((x) => x.id === id);
      if (r && typeof r.elevation !== 'number' && typeof previewElev === 'number') { r.elevation = previewElev; r.elevationPreview = true; }
    }
    renderMap();
    result.ids.forEach((id) => waitForElevation(id, key));
    bumpOwnReputation();
    showView('map');
    const firstMeal = plates[0].meal;
    if (state.filters.meal !== 'any' && !plates.some((p) => p.meal === state.filters.meal)) {
      state.filters.meal = firstMeal;
      $('#f-meal').value = firstMeal;
      renderMap();
    }
    openTown(key);
  } catch (err) {
    console.error(err);
    toast(friendlyError(err));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Submit prices';
  }
});

// ---- offline queue (IndexedDB) ----
const QUEUE_DB = 'dbp-offline';
const QUEUE_STORE = 'reports';
function queueDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(QUEUE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(QUEUE_STORE, { keyPath: 'localId' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function queueTx(mode, fn) {
  const dbx = await queueDb();
  return new Promise((resolve, reject) => {
    const tx = dbx.transaction(QUEUE_STORE, mode);
    const out = fn(tx.objectStore(QUEUE_STORE));
    tx.oncomplete = () => { dbx.close(); resolve(out?.result ?? out); };
    tx.onerror = () => { dbx.close(); reject(tx.error); };
  });
}
const queuePut = (item) => queueTx('readwrite', (st) => st.put(item));
const queueDelete = (id) => queueTx('readwrite', (st) => st.delete(id));
const queueAll = () => queueTx('readonly', (st) => st.getAll()).catch(() => []);

async function myQueue() {
  if (!state.user) return [];
  return (await queueAll()).filter((it) => it.uid === state.user.uid);
}

async function updateQueueStatus() {
  const box = $('#queue-status');
  const items = await myQueue();
  if (!items.length) { box.hidden = true; return; }
  const failed = items.filter((it) => it.error);
  const plates = items.reduce((n, it) => n + it.plates.length, 0);
  box.hidden = false;
  box.innerHTML = `
    <span>⏳ ${items.length} menu photo${items.length > 1 ? 's' : ''} (${plates} price${plates > 1 ? 's' : ''}) waiting to upload${navigator.onLine ? '' : ' — will send when you\'re online'}.
      ${failed.length ? `<br><small>${failed.length} couldn't be sent: ${esc(failed[0].error)}</small>` : ''}</span>
    <span>
      ${navigator.onLine ? '<button class="btn small" data-action="sync-queue">Upload now</button>' : ''}
      ${failed.length ? '<button class="btn small ghost" data-action="discard-failed">Discard failed</button>' : ''}
    </span>`;
}

let syncing = false;
async function syncQueue({ quiet = false } = {}) {
  if (syncing || !state.user || !navigator.onLine) return;
  syncing = true;
  let sent = 0;
  let earned = 0;
  let townKeyToShow = null;
  try {
    for (const item of await myQueue()) {
      try {
        const res = await sendSubmission(item);
        await queueDelete(item.localId);
        sent += item.plates.length;
        earned += 5 + (item.plates.length - 1);
        townKeyToShow = res.townKey;
        res.ids.forEach((id) => waitForElevation(id, res.townKey));
      } catch (err) {
        if (isNetworkError(err)) break; // still offline — try again later
        item.error = friendlyError(err);
        await queuePut(item);
      }
    }
  } finally {
    syncing = false;
  }
  if (sent) {
    celebrate(earned, `⬆️ Uploaded ${sent} saved price${sent > 1 ? 's' : ''} — thanks!`);
    await loadReports();
    bumpOwnReputation();
  } else if (!quiet) {
    const left = await myQueue();
    if (left.length) toast('Still waiting for a connection…');
  }
  updateQueueStatus();
  return townKeyToShow;
}

function updateOnlineState() {
  $('#offline-banner').hidden = navigator.onLine;
renderInstall();
  updateQueueStatus();
  if (navigator.onLine) syncQueue({ quiet: true });
}
window.addEventListener('online', updateOnlineState);
window.addEventListener('offline', updateOnlineState);
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncQueue({ quiet: true }); });
setInterval(() => syncQueue({ quiet: true }), 60000);

function resetReportForm() {
  $('#form-report').reset();
  $('#r-refills').checked = true;
  $('#r-venue').value = 'teahouse';
  resetPlates();
  $('#r-elev').textContent = '';
  $('#r-loc-status').textContent = 'Pick a town above, or tap the map / drag the pin to fine-tune';
  clearPreview('r');
  $('#r-meta').innerHTML = '';
  Object.assign(draft, { meta: null, lat: null, lng: null, geoSource: null, townAuto: true, elevation: null, takenAt: null, timeSource: null });
  selected.r = null;
  stopGps();
  gpsHelp(false);
  if (miniMarker) { miniMarker.remove(); miniMarker = null; }
  if (miniMap) miniMap.fitBounds(NEPAL_BOUNDS);
}

$('#form-post').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.user) return signIn();
  const file = selected.p;
  const townName = $('#p-town').value.trim();
  const priceRaw = $('#p-price').value;
  const price = priceRaw === '' ? null : Number(priceRaw);
  if (!file) return toast('Add a photo of your dal bhat.');
  if (!townName) return toast('Which town?');
  if (price != null && (!Number.isInteger(price) || price < 30 || price > 5000)) return toast('Price should be a whole number between 30 and 5000.');

  const btn = $('#p-submit');
  btn.disabled = true;
  btn.textContent = 'Posting…';
  let path;
  try {
    path = await uploadPhoto(file, 'meals', { rotation: rotation.p });
    const { town, townKey: key } = canonicalTown(townName);
    await addDoc(collection(db, 'posts'), {
      uid: state.user.uid,
      photoPath: path,
      caption: $('#p-caption').value.trim().slice(0, 280),
      town,
      townKey: key,
      priceNpr: price,
      status: 'visible',
      likeCount: 0,
      flagScore: 0,
      createdAt: serverTimestamp(),
    });
    $('#form-post').reset();
    selected.p = null;
    clearPreview('p');
    celebrate(2, 'Posted to the feed — looks delicious!');
    bumpOwnReputation();
    showView('feed');
    loadFeed(true);
  } catch (err) {
    console.error(err);
    if (path) deleteObject(storageRef(storage, path)).catch(() => {});
    toast(friendlyError(err));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Post';
  }
});

/** Reputation is updated by a Cloud Function; re-read it shortly after. */
function bumpOwnReputation() {
  if (!state.user) return;
  setTimeout(async () => {
    const snap = await getDoc(doc(db, 'users', state.user.uid)).catch(() => null);
    if (snap?.exists()) {
      state.profile = snap.data();
      userCache.set(state.user.uid, Promise.resolve(state.profile));
      renderAuth();
    }
  }, 4000);
}

// ---------------------------------------------------------------- me / moderation
async function renderMe() {
  const box = $('#me');
  if (!state.user) {
    box.innerHTML = `
      <div class="card center">
        <h2>Join Dal Bhat Power</h2>
        <p class="muted">Browsing is open to everyone. Sign in with Google to add prices, post your plate, confirm others' prices and flag abuse.</p>
        <button class="btn primary" data-action="signin">Sign in with Google</button>
      </div>
      ${installCard()}
      <div class="card small muted">Found a bug or have an idea? Sign in to send feedback.</div>
      ${aboutCard()}`;
    return;
  }
  const p = state.profile || {};
  box.innerHTML = `
    <div class="card">
      <div class="profile-head">
        ${avatarHtml(p, 56)}
        <div style="flex:1;min-width:0"><b>${esc(p.displayName || state.user.displayName || '')}</b>
          ${p.homeCountry ? `<span title="${esc(countryName(p.homeCountry))}">${flag(p.homeCountry)}</span>` : ''}<br>
          <span class="rep">★ ${esc(p.reputation ?? 0)} reputation</span>
          ${state.isMod ? ' <span class="chip">Moderator</span>' : ''}</div>
        <button class="btn small" data-action="signout">Sign out</button>
      </div>
      ${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : ''}
      ${knownTreks(p.treks).length ? `<div class="badge-row">${knownTreks(p.treks).map(trekBadge).join('')}</div>` : ''}
      ${p.banned ? '<p class="chip warn" style="margin-top:10px">Your account is suspended from posting.</p>' : ''}
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <button class="btn small" data-action="edit-profile">✎ Edit profile</button>
        <button class="btn small ghost" data-action="profile" data-uid="${esc(state.user.uid)}">View public profile</button>
      </div>
      <details style="margin-top:10px"><summary class="muted small">How reputation works</summary>
        <ul class="small muted">
          <li>+5 per menu photo (+1 for each extra plate on it), +2 per feed post</li>
          <li>+2 when someone confirms your price, +1 per like</li>
          <li>−15 if the community hides your item; deleting your own item removes its points</li>
          <li>Flags from members with 30+ reputation count double, 100+ count triple</li>
        </ul>
      </details>
    </div>
    ${installCard()}
    ${feedbackCard()}
    <div class="card"><h2>My price reports</h2><div id="my-reports"><p class="muted">Loading…</p></div></div>
    <div class="card"><h2>My feed posts</h2><div id="my-posts"><p class="muted">Loading…</p></div></div>
    ${state.isMod ? '<div class="card"><h2>Moderation queue</h2><div id="mod-queue"><p class="muted">Loading…</p></div></div>' : ''}
    ${state.isMod ? '<div class="card"><h2>Feedback inbox</h2><div id="feedback-inbox"><p class="muted">Loading…</p></div></div>' : ''}
    ${aboutCard()}`;

  const uid = state.user.uid;
  const [myReports, myPosts] = await Promise.all([
    getDocs(query(collection(db, 'reports'), where('uid', '==', uid), orderBy('createdAt', 'desc'), limit(50))).catch(() => null),
    getDocs(query(collection(db, 'posts'), where('uid', '==', uid), orderBy('createdAt', 'desc'), limit(50))).catch(() => null),
  ]);
  $('#my-reports').innerHTML = myReports?.docs.length
    ? myReports.docs.map((d) => ownItemRow('reports', d.id, d.data())).join('')
    : '<p class="muted">None yet.</p>';
  $('#my-posts').innerHTML = myPosts?.docs.length
    ? myPosts.docs.map((d) => ownItemRow('posts', d.id, d.data())).join('')
    : '<p class="muted">None yet.</p>';
  if (state.isMod) { renderModQueue(); renderFeedbackInbox(); }
  renderMyFeedback();
}

function ownItemRow(type, id, d) {
  const title = type === 'reports'
    ? `${fmtRs(d.priceNpr)} · ${esc(MEAL_LABEL[d.meal] || d.meal)} · ${esc(d.town)}`
    : `${esc(d.town)}${d.caption ? ' — ' + esc(d.caption.slice(0, 60)) : ''}`;
  return `
    <div class="report">
      <img src="${esc(photoUrl(d.photoPath))}" alt="" loading="lazy">
      <div class="info">
        <div>${title}</div>
        <div class="muted small">${fmtDate(d.createdAt)} · <span class="status ${esc(d.status)}">${esc(d.status)}</span>
          ${type === 'reports' ? ` · ✓${d.confirmCount || 0}` : ` · ♥${d.likeCount || 0}`}</div>
        <div class="actions"><button class="icon-btn" data-action="delete" data-type="${type}" data-id="${esc(id)}">🗑 Delete</button></div>
      </div>
    </div>`;
}

async function renderModQueue() {
  const [hr, hp] = await Promise.all([
    getDocs(query(collection(db, 'reports'), where('status', '==', 'hidden'), orderBy('createdAt', 'desc'), limit(50))),
    getDocs(query(collection(db, 'posts'), where('status', '==', 'hidden'), orderBy('createdAt', 'desc'), limit(50))),
  ]).catch((err) => { toast(friendlyError(err)); return [null, null]; });
  const items = [
    ...(hr?.docs || []).map((d) => ({ type: 'reports', id: d.id, ...d.data() })),
    ...(hp?.docs || []).map((d) => ({ type: 'posts', id: d.id, ...d.data() })),
  ];
  const box = $('#mod-queue');
  if (!box) return;
  if (!items.length) { box.innerHTML = '<p class="muted">Nothing hidden. 🎉</p>'; return; }
  box.innerHTML = items.map((it) => `
    <div class="report" data-mod="${esc(it.type)}:${esc(it.id)}">
      <a href="${esc(photoUrl(it.photoPath))}" target="_blank" rel="noopener"><img src="${esc(photoUrl(it.photoPath))}" alt=""></a>
      <div class="info">
        <div>${it.type === 'reports' ? `${fmtRs(it.priceNpr)} · ${esc(it.town)}` : `Post · ${esc(it.town)} ${esc((it.caption || '').slice(0, 80))}`}</div>
        <div class="muted small">Hidden by ${esc(it.hiddenReason || '?')} · flag score ${it.flagScore || 0} · <span class="by" data-action="profile" data-uid="${esc(it.uid)}">…</span></div>
        <div class="muted small flag-reasons">…</div>
        <div class="actions">
          <button class="btn small" data-action="mod" data-op="restore" data-type="${esc(it.type)}" data-id="${esc(it.id)}">Restore</button>
          <button class="btn small danger" data-action="mod" data-op="remove" data-type="${esc(it.type)}" data-id="${esc(it.id)}">Remove</button>
          <button class="btn small danger" data-action="ban" data-uid="${esc(it.uid)}">Ban author</button>
        </div>
      </div>
    </div>`).join('');
  items.forEach(async (it) => {
    const row = $(`[data-mod="${CSS.escape(it.type + ':' + it.id)}"]`);
    const u = await getUserInfo(it.uid);
    $('.by', row).innerHTML = userLabel(u);
    const flags = await getDocs(query(collection(db, 'flags'), where('targetType', '==', it.type), where('targetId', '==', it.id))).catch(() => null);
    $('.flag-reasons', row).textContent = flags?.docs.length
      ? flags.docs.map((f) => FLAG_REASONS[f.data().reason] + (f.data().note ? ` (“${f.data().note}”)` : '')).join(' · ')
      : 'No flags';
  });
}

function aboutCard() {
  return `
    <div class="card small muted">
      <b>About.</b> Dal Bhat Power is a crowdsourced index of what a plate of dal bhat costs across Nepal, inspired by fuel-price apps.
      Photo timestamps and locations are read on your device and stripped before upload. Report locations are public; feed posts only show the town.
      Elevations from <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a>; map © OpenStreetMap contributors.
    </div>`;
}

// ---------------------------------------------------------------- profiles
function avatarHtml(u, size = 30) {
  const st = `width:${size}px;height:${size}px`;
  if (u?.photoURL) return `<img class="avatar" style="${st}" src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">`;
  const initial = (u?.displayName || '?').trim().charAt(0).toUpperCase();
  return `<span class="avatar avatar-initial" style="${st};font-size:${Math.round(size * 0.45)}px">${esc(initial)}</span>`;
}

async function openProfile(uid) {
  openSheet('<p class="muted">Loading profile…</p>');
  const snap = await getDoc(doc(db, 'users', uid)).catch(() => null);
  const u = snap?.exists() ? snap.data() : { displayName: 'Someone', reputation: 0 };
  userCache.set(uid, Promise.resolve(u));
  const visible = (coll) => getCountFromServer(query(collection(db, coll), where('uid', '==', uid), where('status', '==', 'visible')))
    .then((c) => c.data().count).catch(() => null);
  const [nReports, nPosts] = await Promise.all([visible('reports'), visible('posts')]);
  const treks = knownTreks(u.treks);
  const joined = u.createdAt ? toDate(u.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : '';
  openSheet(`
    <div class="profile-head">
      ${avatarHtml(u, 72)}
      <div style="min-width:0">
        <h2 style="margin:0">${esc(u.displayName || 'Someone')}</h2>
        ${u.homeCountry ? `<div>${flag(u.homeCountry)} ${esc(countryName(u.homeCountry))}</div>` : ''}
        <div class="muted small">★ ${esc(u.reputation ?? 0)} reputation${joined ? ` · joined ${esc(joined)}` : ''}</div>
      </div>
    </div>
    ${u.bio ? `<p class="bio">${esc(u.bio)}</p>` : ''}
    <div class="stats">
      <div class="stat"><b>${nReports ?? '—'}</b><span>prices</span></div>
      <div class="stat"><b>${nPosts ?? '—'}</b><span>feed posts</span></div>
      <div class="stat"><b>${treks.length}</b><span>treks</span></div>
    </div>
    ${treks.length ? `<h3>Treks</h3><ul class="trek-list">${treks.map((t) => `<li>${trekBadge(t)} ${esc(t.name)} <span class="muted small">${esc(t.region)}</span></li>`).join('')}</ul>` : ''}
  `);
}

function openEditProfile() {
  const p = state.profile || {};
  const mine = new Set(p.treks || []);
  const regions = [...new Set(TREKS.map((t) => t.region))];
  openSheet(`
    <h2>Edit profile</h2>
    <form id="profile-form" class="form">
      <div class="profile-head">
        <span id="pf-avatar">${avatarHtml(p, 64)}</span>
        <div>
          <label class="btn small" style="display:inline-block;margin:0;color:var(--ink)">Change photo
            <input type="file" id="pf-photo" accept="image/*,.heic,.heif" hidden>
          </label>
          ${p.photoURL ? '<button type="button" class="btn small ghost" id="pf-photo-remove">Remove</button>' : ''}
        </div>
      </div>
      <label>Display name<input id="pf-name" maxlength="60" required value="${esc(p.displayName || '')}"></label>
      <label>About me <span class="muted small">(<span id="pf-bio-n">${(p.bio || '').length}</span>/280)</span>
        <textarea id="pf-bio" maxlength="280" rows="3" placeholder="Where you're from, favourite dal bhat stop…">${esc(p.bio || '')}</textarea></label>
      <label>Home country
        <select id="pf-country">
          <option value="">—</option>
          ${countryOptions().map((c) => `<option value="${c.code}" ${c.code === p.homeCountry ? 'selected' : ''}>${flag(c.code)} ${esc(c.name)}</option>`).join('')}
        </select></label>
      <fieldset class="loc treks-pick"><legend>Treks you've done</legend>
        ${regions.map((r) => `
          <div class="muted small" style="margin-top:6px">${esc(r)}</div>
          ${TREKS.filter((t) => t.region === r).map((t) => `
            <label class="check"><input type="checkbox" name="trek" value="${t.id}" ${mine.has(t.id) ? 'checked' : ''}> ${trekBadge(t)} ${esc(t.name)}</label>`).join('')}`).join('')}
      </fieldset>
      <button class="btn primary wide" type="submit" id="pf-save">Save profile</button>
    </form>`);
  const form = $('#profile-form');
  form.dataset.photo = '';
  $('#pf-bio').addEventListener('input', (e) => { $('#pf-bio-n').textContent = e.target.value.length; });
  $('#pf-photo').addEventListener('change', async (e) => {
    const file = await snapshotFile(e.target.files[0]);
    if (!file) return;
    try {
      const blob = await reencodeJpeg(file, { maxSide: 400, quality: 0.85, square: true });
      form._avatarBlob = blob;
      form.dataset.photo = 'new';
      $('#pf-avatar').innerHTML = `<img class="avatar" style="width:64px;height:64px" src="${URL.createObjectURL(blob)}" alt="">`;
    } catch (err) { toast(err.message); }
  });
  $('#pf-photo-remove')?.addEventListener('click', () => {
    form.dataset.photo = 'remove';
    form._avatarBlob = null;
    $('#pf-avatar').innerHTML = avatarHtml({ displayName: $('#pf-name').value }, 64);
  });
}

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'profile-form') return;
  e.preventDefault();
  const form = e.target;
  const name = $('#pf-name').value.trim();
  if (!name) return toast('Add a display name.');
  const treks = $$('input[name="trek"]:checked', form).map((i) => i.value).slice(0, MAX_TREKS);
  const btn = $('#pf-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const update = {
      displayName: name.slice(0, 60),
      bio: $('#pf-bio').value.trim().slice(0, 280),
      homeCountry: $('#pf-country').value || null,
      treks,
    };
    if (form.dataset.photo === 'new' && form._avatarBlob) {
      const path = `uploads/${state.user.uid}/avatars/${Date.now()}.jpg`;
      await uploadBytes(storageRef(storage, path), form._avatarBlob, {
        contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable',
      });
      update.photoURL = photoUrl(path);
    } else if (form.dataset.photo === 'remove') {
      update.photoURL = null;
    }
    await updateDoc(doc(db, 'users', state.user.uid), update);
    state.profile = { ...state.profile, ...update };
    userCache.set(state.user.uid, Promise.resolve(state.profile));
    sheet.close();
    toast('Profile saved.');
    renderAuth();
    renderMe();
  } catch (err) {
    console.error(err);
    toast(friendlyError(err));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save profile';
  }
});

// ---------------------------------------------------------------- feedback
const FEEDBACK_KINDS = { bug: '🐞 Bug', idea: '💡 Feature idea', other: '💬 Other' };

function feedbackCard() {
  return `
    <div class="card" id="feedback">
      <h2>Feedback</h2>
      <p class="muted small">Found a bug or want a feature? Tell us. Moderators read every message.</p>
      <form id="feedback-form" class="form">
        <div class="segmented" role="radiogroup">
          ${Object.entries(FEEDBACK_KINDS).map(([k, v], i) => `
            <label class="seg ${i === 0 ? 'active' : ''}" style="margin:0;text-align:center"><input type="radio" name="kind" value="${k}" ${i === 0 ? 'checked' : ''} hidden>${v}</label>`).join('')}
        </div>
        <textarea name="message" maxlength="2000" rows="4" required placeholder="What happened, or what would you like? For bugs, what did you expect instead?"></textarea>
        <button class="btn primary wide" type="submit" style="margin-top:10px">Send feedback</button>
      </form>
      <div id="my-feedback"></div>
    </div>`;
}

document.addEventListener('change', (e) => {
  if (e.target.name === 'kind' && e.target.closest('#feedback-form')) {
    $$('#feedback-form .seg').forEach((l) => l.classList.toggle('active', $('input', l).checked));
  }
});

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'feedback-form') return;
  e.preventDefault();
  if (!state.user) return signIn();
  const fd = new FormData(e.target);
  const message = String(fd.get('message') || '').trim();
  if (message.length < 5) return toast('Tell us a little more.');
  const btn = $('button[type="submit"]', e.target);
  btn.disabled = true;
  try {
    await addDoc(collection(db, 'feedback'), {
      uid: state.user.uid,
      kind: fd.get('kind') || 'other',
      message: message.slice(0, 2000),
      page: location.pathname.slice(0, 100),
      userAgent: navigator.userAgent.slice(0, 300),
      status: 'open',
      createdAt: serverTimestamp(),
    });
    e.target.reset();
    $$('#feedback-form .seg').forEach((l, i) => l.classList.toggle('active', i === 0));
    toast('Thanks — feedback sent!');
    renderMyFeedback();
  } catch (err) {
    toast(friendlyError(err));
  } finally {
    btn.disabled = false;
  }
});

const FEEDBACK_STATUS = { open: 'Open', done: 'Done ✓', wontfix: "Won't fix" };

async function renderMyFeedback() {
  const box = $('#my-feedback');
  if (!box || !state.user) return;
  const snap = await getDocs(query(collection(db, 'feedback'), where('uid', '==', state.user.uid), orderBy('createdAt', 'desc'), limit(10))).catch(() => null);
  if (!snap?.docs.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<h3 style="margin-top:14px">Your feedback</h3>` + snap.docs.map((d) => {
    const f = d.data();
    return `<div class="report"><div class="info"><div>${esc(FEEDBACK_KINDS[f.kind] || f.kind)} · <span class="status">${esc(FEEDBACK_STATUS[f.status] || f.status)}</span></div>
      <div class="small">${esc(f.message.slice(0, 200))}${f.message.length > 200 ? '…' : ''}</div>
      <div class="muted small">${fmtDate(f.createdAt)}</div></div></div>`;
  }).join('');
}

async function renderFeedbackInbox() {
  const box = $('#feedback-inbox');
  if (!box) return;
  const snap = await getDocs(query(collection(db, 'feedback'), where('status', '==', 'open'), orderBy('createdAt', 'desc'), limit(50)))
    .catch((err) => { toast(friendlyError(err)); return null; });
  if (!snap?.docs.length) { box.innerHTML = '<p class="muted">No open feedback. 🎉</p>'; return; }
  box.innerHTML = snap.docs.map((d) => {
    const f = d.data();
    return `
      <div class="report" data-feedback="${esc(d.id)}">
        <div class="info">
          <div>${esc(FEEDBACK_KINDS[f.kind] || f.kind)} · <span class="by" data-action="profile" data-uid="${esc(f.uid)}">…</span> · <span class="muted small">${fmtDate(f.createdAt)}</span></div>
          <div style="white-space:pre-wrap">${esc(f.message)}</div>
          <div class="muted small" style="word-break:break-all">${esc(f.userAgent || '')}</div>
          <div class="actions">
            <button class="btn small" data-action="feedback-status" data-status="done" data-id="${esc(d.id)}">Mark done</button>
            <button class="btn small ghost" data-action="feedback-status" data-status="wontfix" data-id="${esc(d.id)}">Won't fix</button>
          </div>
        </div>
      </div>`;
  }).join('');
  snap.docs.forEach(async (d) => {
    const u = await getUserInfo(d.data().uid);
    const el = $(`[data-feedback="${CSS.escape(d.id)}"] .by`);
    if (el) el.innerHTML = userLabel(u);
  });
}

// ---------------------------------------------------------------- install as an app
let installEvent = null;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// Laptops/desktops get a QR code to open the app on their phone instead of a desktop install.
const isMobileDevice = navigator.userAgentData?.mobile
  ?? (isIOS || /android|mobile|iphone|ipod/i.test(navigator.userAgent));
const isDesktop = !isMobileDevice;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  if (isDesktop) return; // we offer a phone QR code instead
  installEvent = e;
  renderInstall();
});
window.addEventListener('appinstalled', () => {
  installEvent = null;
  toast('Installed! Find Dal Bhat Power on your home screen.');
  renderInstall();
});

function installCard() {
  if (isStandalone()) return '';
  if (isDesktop) {
    return `<div class="card install-card"><h2>📲 Get the app on your phone</h2>
      <p class="muted small" style="margin:4px 0 0">The app is made for phones: it records GPS when you take a menu photo, and saves prices with no signal.</p>
      <button class="btn primary" data-action="install" style="margin-top:10px">Show QR code</button></div>`;
  }
  const why = '<p class="muted small" style="margin:4px 0 0">The app records GPS when you take a menu photo, and saves prices with no signal — they upload once you\'re back online.</p>';
  if (installEvent) {
    return `<div class="card install-card"><h2>📲 Install the app</h2>${why}
      <button class="btn primary" data-action="install" style="margin-top:10px">Install Dal Bhat Power</button></div>`;
  }
  if (isIOS) {
    return `<div class="card install-card"><h2>📲 Install the app</h2>${why}
      <ol class="small"><li>Open this page in <b>Safari</b></li><li>Tap the <b>Share</b> button ⬆︎</li><li>Choose <b>Add to Home Screen</b></li></ol></div>`;
  }
  return '';
}

function renderInstall() {
  $('#install-btn').hidden = isStandalone() || !(installEvent || isDesktop);
  $('#install-btn').textContent = isDesktop ? '📲 Get the app' : '📲 Install';
  if ($('#view-me').classList.contains('active')) renderMe();
}

// QR code library (qrcode-generator), loaded only when a laptop user asks for the code.
let qrLibPromise;
function loadQrLib() {
  if (!qrLibPromise) {
    qrLibPromise = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js';
      el.onload = () => (window.qrcode ? resolve(window.qrcode) : reject(new Error('QR library missing')));
      el.onerror = () => { qrLibPromise = null; reject(new Error('Could not load the QR code library')); };
      document.head.appendChild(el);
    });
  }
  return qrLibPromise;
}

async function showPhoneQr() {
  const url = `${location.origin}/?source=qr`;
  openSheet(`
    <h2>📲 Open on your phone</h2>
    <p class="muted">Scan with your phone's camera, then install from there:</p>
    <div id="qr-box" class="qr-box"><p class="muted">Making QR code…</p></div>
    <p class="center"><a href="${esc(url)}">${esc(location.host)}</a></p>
    <ul class="small muted">
      <li><b>Android:</b> open in Chrome and tap <b>Install</b>.</li>
      <li><b>iPhone:</b> open in Safari, tap <b>Share ⬆︎</b>, then <b>Add to Home Screen</b>.</li>
    </ul>`);
  try {
    const qrcode = await loadQrLib();
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    $('#qr-box').innerHTML = qr.createSvgTag({ cellSize: 8, margin: 4, scalable: true });
  } catch (err) {
    $('#qr-box').innerHTML = `<p class="muted">${esc(err.message)} — type the address below on your phone instead.</p>`;
  }
}

async function promptInstall() {
  if (isDesktop) return showPhoneQr();
  if (!installEvent) {
    if (isIOS) toast('In Safari: tap Share ⬆︎, then "Add to Home Screen".');
    return;
  }
  installEvent.prompt();
  await installEvent.userChoice.catch(() => null);
  installEvent = null;
  renderInstall();
}

if ('serviceWorker' in navigator && !useEmulators) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker failed', err));
  });
}

// ---------------------------------------------------------------- celebration
// "+7 ★" banner with dal bhat confetti when someone contributes.
const CONFETTI = ['🍛', '🍛', '🍛', '🍚', '🍚', '⭐', '🥟', '🌶️', '🫓'];
function celebrate(points, message) {
  document.querySelector('.celebrate')?.remove();
  const box = document.createElement('div');
  box.className = 'celebrate';
  box.setAttribute('role', 'status');
  box.innerHTML = `
    <div class="celebrate-card">
      <div class="celebrate-points">+<span class="celebrate-n">0</span> <span class="celebrate-star">★</span></div>
      <div class="celebrate-msg"></div>
    </div>`;
  $('.celebrate-msg', box).textContent = message;
  document.body.appendChild(box);

  // Count up the points.
  const n = $('.celebrate-n', box);
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 700);
    n.textContent = Math.round(points * (1 - (1 - k) ** 3));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);

  // Emoji rain (skipped for people who prefer reduced motion).
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const count = Math.min(60, 24 + points * 3);
    for (let i = 0; i < count; i++) {
      const e = document.createElement('span');
      e.className = 'confetti';
      e.textContent = CONFETTI[Math.floor(Math.random() * CONFETTI.length)];
      e.style.left = `${Math.random() * 100}vw`;
      e.style.fontSize = `${18 + Math.random() * 22}px`;
      e.style.setProperty('--drift', `${(Math.random() - 0.5) * 160}px`);
      e.style.setProperty('--spin', `${(Math.random() - 0.5) * 720}deg`);
      e.style.animationDuration = `${1.8 + Math.random() * 1.6}s`;
      e.style.animationDelay = `${Math.random() * 0.6}s`;
      box.appendChild(e);
    }
  }
  if (navigator.vibrate) navigator.vibrate(30);
  box.addEventListener('click', () => box.remove());
  setTimeout(() => box.classList.add('leaving'), 3200);
  setTimeout(() => box.remove(), 3800);
  // Pulse the reputation badge once the server has added the points.
  setTimeout(() => $('#auth-area .rep')?.classList.add('rep-bump'), 4200);
  setTimeout(() => $('#auth-area .rep')?.classList.remove('rep-bump'), 5200);
}

// ---------------------------------------------------------------- global actions
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'signin') return signIn();
  if (action === 'profile') { e.preventDefault(); return openProfile(el.dataset.uid); }
  if (action === 'edit-profile') return openEditProfile();
  if (action === 'go-me') return showView('me');
  if (action === 'go-add') return showView('add');
  if (action === 'install') return promptInstall();
  if (action === 'sync-queue') return syncQueue();
  if (action === 'discard-failed') {
    if (!confirm('Discard the saved submissions that failed to upload?')) return;
    for (const it of await myQueue()) if (it.error) await queueDelete(it.localId);
    return updateQueueStatus();
  }
  if (action === 'feedback-status') {
    el.disabled = true;
    try {
      await updateDoc(doc(db, 'feedback', el.dataset.id), { status: el.dataset.status });
      el.closest('.report')?.remove();
      toast('Updated.');
    } catch (err) { toast(friendlyError(err)); el.disabled = false; }
    return;
  }
  if (action === 'signout') { await signOut(auth); showView('map'); return; }
  if (action === 'close-sheet') return sheet.close();
  if (action === 'confirm') return toggleConfirm(el);
  if (action === 'like') return toggleLike(el);
  if (action === 'flag') return openFlag(el.dataset.type, el.dataset.id);
  if (action === 'delete') {
    if (!confirm('Delete this permanently? Its reputation points are removed too.')) return;
    try {
      await deleteDoc(doc(db, el.dataset.type, el.dataset.id));
      toast('Deleted.');
      el.closest('.report, .post')?.remove();
      state.reports = state.reports.filter((r) => r.id !== el.dataset.id);
      renderMap();
      bumpOwnReputation();
    } catch (err) { toast(friendlyError(err)); }
    return;
  }
  if (action === 'mod') {
    el.disabled = true;
    try {
      await moderateFn({ targetType: el.dataset.type, targetId: el.dataset.id, action: el.dataset.op });
      toast(el.dataset.op === 'restore' ? 'Restored.' : 'Removed.');
      el.closest('.report')?.remove();
      if (el.dataset.op === 'restore') loadReports();
    } catch (err) { toast(friendlyError(err)); el.disabled = false; }
    return;
  }
  if (action === 'ban') {
    if (!confirm('Ban this user from posting, confirming, liking and flagging?')) return;
    try {
      await setBannedFn({ uid: el.dataset.uid, banned: true });
      toast('User banned.');
    } catch (err) { toast(friendlyError(err)); }
  }
});

// ---------------------------------------------------------------- boot
{
  const v = new URLSearchParams(location.search).get('view');
  if (['map', 'trends', 'add', 'feed', 'me'].includes(v)) setTimeout(() => showView(v), 0);
}
$('#offline-banner').hidden = navigator.onLine;
$('#r-refills').checked = true;
refreshTownList();
renderMap();
loadReports();
