// Dal Bhat Index — frontend (no build step; ES modules from CDNs).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged,
  signOut, connectAuthEmulator,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, connectFirestoreEmulator, collection, doc, getDoc, getDocs, setDoc, addDoc,
  deleteDoc, query, where, orderBy, limit, startAfter, serverTimestamp, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {
  getStorage, connectStorageEmulator, ref as storageRef, uploadBytes, deleteObject,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js';
import {
  getFunctions, connectFunctionsEmulator, httpsCallable,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js';

import { firebaseConfig, firestoreDatabase, functionsRegion, useEmulators } from './config.js';
import { TOWNS, townKey, nearestTown, inNepal, NEPAL_BOUNDS } from './towns.js';
import { readPhotoMeta, reencodeJpeg } from './photo.js';
import { scatterChart, lineChart, linearFit } from './charts.js';

// ---------------------------------------------------------------- Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app, firestoreDatabase || '(default)');
const storage = getStorage(app);
const functions = getFunctions(app, functionsRegion);
if (useEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
}
const moderateFn = httpsCallable(functions, 'moderate');
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
const MEAL_LABEL = { veg: 'Veg', chicken: 'Chicken', mutton: 'Mutton', fish: 'Fish', other: 'Other' };
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
  if (name === 'add') setTimeout(initMiniMap, 50);
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
    ${p.photoURL ? `<img class="avatar" src="${esc(p.photoURL)}" alt="" referrerpolicy="no-referrer">` : ''}`;
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
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function baseLayer() {
  const style = darkQuery.matches ? 'dark_all' : 'light_all';
  return L.tileLayer(`https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`, {
    subdomains: 'abcd',
    maxZoom: 16,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
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
    <h2>${esc(town.name)}</h2>
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
        <div class="muted small">${fmtDate(r.observedAt)}${r.timeSource === 'exif' ? ' 📷' : ''}${r.elevation != null ? ` · ${fmtM(r.elevation)}` : ''} · <span class="by" data-uid="${esc(r.uid)}">…</span></div>
        <div class="actions">
          ${mine ? '' : `<button class="icon-btn" data-action="confirm" data-id="${esc(r.id)}" title="I paid this too">✓ <span class="cc">${r.confirmCount || 0}</span></button>`}
          ${mine ? '' : `<button class="icon-btn" data-action="flag" data-type="reports" data-id="${esc(r.id)}">⚑ Flag</button>`}
          ${mine ? `<button class="icon-btn" data-action="delete" data-type="reports" data-id="${esc(r.id)}">🗑 Delete</button>` : ''}
        </div>
      </div>
    </div>`;
}

async function hydrateReportRows(reports) {
  await Promise.all(reports.map(async (r) => {
    const row = $(`.report[data-report="${CSS.escape(r.id)}"]`);
    if (!row) return;
    const u = await getUserInfo(r.uid);
    const by = $('.by', row);
    if (by) by.textContent = `${u.displayName || 'Someone'} ★${u.reputation ?? 0}`;
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
        <div class="who"><b class="name">…</b><span class="muted small">${esc(p.town)} · ${fmtDate(p.createdAt)}</span></div>
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
    $('.name', card).textContent = `${u.displayName || 'Someone'} ★${u.reputation ?? 0}`;
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

const draft = { meta: null, lat: null, lng: null, geoSource: null, townAuto: true };
let miniMap, miniMarker;

function initMiniMap() {
  if ($('#form-report').hidden || !$('#view-add').classList.contains('active') || !state.user) return;
  if (miniMap) { miniMap.invalidateSize(); return; }
  miniMap = L.map('r-map', { minZoom: 6, maxBounds: NEPAL_VIEW_LIMIT }).fitBounds(NEPAL_BOUNDS);
  baseLayer().addTo(miniMap);
  miniMap.on('click', (e) => setLocation(e.latlng.lat, e.latlng.lng, 'map'));
  if (draft.lat != null) setLocation(draft.lat, draft.lng, draft.geoSource);
}

function setLocation(lat, lng, source) {
  if (!inNepal(lat, lng)) { toast('That location is outside Nepal.'); return; }
  draft.lat = lat; draft.lng = lng; draft.geoSource = source;
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
    <li role="option" data-i="${i}" class="${i === 0 ? 'active' : ''}">${esc(p.name)}<small>${esc(p.detail || '')}</small></li>`).join('')
    + (note ? `<li class="note">${esc(note)}</li>` : '');
  const show = items.length > 0 || !!note;
  suggestBox.hidden = !show;
  townInput.setAttribute('aria-expanded', String(show));
}

async function geocode(q) {
  if (geocodeAbort) geocodeAbort.abort();
  geocodeAbort = new AbortController();
  const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
    q, format: 'jsonv2', countrycodes: 'np', limit: '6', 'accept-language': 'en',
  });
  const res = await fetch(url, { signal: geocodeAbort.signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const rows = await res.json();
  return rows
    .map((r) => ({
      name: (r.name || r.display_name.split(',')[0]).slice(0, 60),
      lat: Number(r.lat),
      lng: Number(r.lon),
      detail: r.display_name.split(',').slice(1, 4).join(',').trim(),
    }))
    .filter((p) => p.name && inNepal(p.lat, p.lng));
}

townInput.addEventListener('input', () => {
  draft.townAuto = false;
  const q = townInput.value.trim();
  clearTimeout(geocodeTimer);
  if (q.length < 2) { renderSuggest([]); return; }
  const local = localMatches(q);
  renderSuggest(local, q.length >= 3 ? 'Searching map…' : null);
  if (q.length < 3) return;
  geocodeTimer = setTimeout(async () => {
    try {
      const remote = await geocode(q);
      if (townInput.value.trim() !== q) return; // user kept typing
      const seen = new Set(local.map((p) => townKey(p.name)));
      const merged = [...local, ...remote.filter((p) => !seen.has(townKey(p.name)) && seen.add(townKey(p.name)))];
      renderSuggest(merged.slice(0, 8), merged.length ? null : 'No places found — tap the map to set the spot');
    } catch (err) {
      if (err.name !== 'AbortError') renderSuggest(local, local.length ? null : "Couldn't search right now — tap the map instead");
    }
  }, 450); // Nominatim asks for ≤1 request/second
});

function pickSuggestion(i) {
  const p = suggestItems[i];
  if (!p) return;
  townInput.value = p.name;
  draft.townAuto = false;
  renderSuggest([]);
  setLocation(p.lat, p.lng, 'map');
  $('#r-loc-status').textContent = `Pin set to ${p.name} — drag it to the exact spot if you like`;
}

suggestBox.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  e.preventDefault(); // keep focus so blur doesn't close the list first
  pickSuggestion(Number(li.dataset.i));
});

townInput.addEventListener('keydown', (e) => {
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
    () => toast("Couldn't get your location — tap the map instead."),
    { enableHighAccuracy: true, timeout: 10000 },
  );
});

$('#r-photo').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  const preview = $('#r-preview');
  const chips = $('#r-meta');
  chips.innerHTML = '';
  if (!file) { preview.hidden = true; return; }
  preview.src = URL.createObjectURL(file);
  preview.hidden = false;
  const meta = await readPhotoMeta(file);
  draft.meta = meta;
  const out = [];
  if (meta.takenAt) {
    out.push(`<span class="chip">🕒 Taken ${esc(meta.takenAt.toLocaleString())}</span>`);
    const days = (Date.now() - meta.takenAt) / 86400000;
    if (days > 60) out.push(`<span class="chip warn">Photo is ${Math.round(days)} days old — it'll be dated then</span>`);
  } else {
    out.push('<span class="chip warn">No timestamp in photo — using upload time</span>');
  }
  if (meta.lat != null) {
    out.push('<span class="chip">📍 Location from photo</span>');
    setLocation(meta.lat, meta.lng, 'exif');
  } else if (meta.gpsOutsideNepal) {
    out.push('<span class="chip warn">Photo location is outside Nepal — set it below</span>');
  } else {
    out.push('<span class="chip warn">No location in photo — use your location or tap the map</span>');
  }
  chips.innerHTML = out.join('');
});

$('#p-photo').addEventListener('change', (e) => {
  const file = e.target.files[0];
  const preview = $('#p-preview');
  if (!file) { preview.hidden = true; return; }
  preview.src = URL.createObjectURL(file);
  preview.hidden = false;
});

async function uploadPhoto(file, kind) {
  const blob = await reencodeJpeg(file);
  if (blob.size > 3 * 1024 * 1024) throw new Error('Photo is too large even after resizing.');
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.jpg`;
  const path = `uploads/${state.user.uid}/${kind}/${name}`;
  await uploadBytes(storageRef(storage, path), blob, {
    contentType: 'image/jpeg',
    cacheControl: 'public, max-age=31536000, immutable', // photos never change; cache once per viewer
  });
  return path;
}

$('#form-report').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.user) return signIn();
  const file = $('#r-photo').files[0];
  const price = Number($('#r-price').value);
  const townName = $('#r-town').value.trim();
  if (!file) return toast('Add a photo of the menu.');
  if (!Number.isInteger(price) || price < 30 || price > 5000) return toast('Price should be a whole number between 30 and 5000.');
  if (!townName) return toast('Which town or village is this?');
  if (draft.lat == null) {
    const known = knownPlaces().find((p) => townKey(p.name) === townKey(townName));
    if (known) setLocation(known.lat, known.lng, 'map');
  }
  if (draft.lat == null) return toast('Pick the town from the search list, use your location, or tap the map.');

  const btn = $('#r-submit');
  btn.disabled = true;
  btn.textContent = 'Uploading…';
  let path;
  try {
    path = await uploadPhoto(file, 'menus');
    const takenAt = draft.meta?.takenAt;
    const { town, townKey: key } = canonicalTown(townName);
    await addDoc(collection(db, 'reports'), {
      uid: state.user.uid,
      town,
      townKey: key,
      lat: Number(draft.lat.toFixed(5)),
      lng: Number(draft.lng.toFixed(5)),
      geoSource: draft.geoSource,
      priceNpr: price,
      meal: $('#r-meal').value,
      venueType: $('#r-venue').value,
      venueName: $('#r-venue-name').value.trim().slice(0, 80),
      refills: $('#r-refills').checked,
      photoPath: path,
      observedAt: takenAt ? Timestamp.fromDate(takenAt) : serverTimestamp(),
      timeSource: takenAt ? 'exif' : 'upload',
      status: 'visible',
      flagScore: 0,
      confirmCount: 0,
      createdAt: serverTimestamp(),
    });
    toast('Thanks! Price added. +5 reputation');
    resetReportForm();
    await loadReports();
    bumpOwnReputation();
    showView('map');
    openTown(key);
  } catch (err) {
    console.error(err);
    if (path) deleteObject(storageRef(storage, path)).catch(() => {});
    toast(friendlyError(err));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Submit price';
  }
});

function resetReportForm() {
  $('#form-report').reset();
  $('#r-refills').checked = true;
  $('#r-venue').value = 'teahouse';
  $('#r-loc-status').textContent = 'Pick a town above, or tap the map / drag the pin to fine-tune';
  $('#r-preview').hidden = true;
  $('#r-meta').innerHTML = '';
  Object.assign(draft, { meta: null, lat: null, lng: null, geoSource: null, townAuto: true });
  if (miniMarker) { miniMarker.remove(); miniMarker = null; }
  if (miniMap) miniMap.fitBounds(NEPAL_BOUNDS);
}

$('#form-post').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.user) return signIn();
  const file = $('#p-photo').files[0];
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
    path = await uploadPhoto(file, 'meals');
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
    $('#p-preview').hidden = true;
    toast('Posted! +2 reputation');
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
        <h2>Join the Dal Bhat Index</h2>
        <p class="muted">Browsing is open to everyone. Sign in with Google to add prices, post your plate, confirm others' prices and flag abuse.</p>
        <button class="btn primary" data-action="signin">Sign in with Google</button>
      </div>
      ${aboutCard()}`;
    return;
  }
  const p = state.profile || {};
  box.innerHTML = `
    <div class="card">
      <div style="display:flex;gap:12px;align-items:center">
        ${p.photoURL ? `<img class="avatar" style="width:48px;height:48px" src="${esc(p.photoURL)}" alt="" referrerpolicy="no-referrer">` : ''}
        <div style="flex:1"><b>${esc(p.displayName || state.user.displayName || '')}</b><br>
          <span class="rep">★ ${esc(p.reputation ?? 0)} reputation</span>
          ${state.isMod ? ' <span class="chip">Moderator</span>' : ''}</div>
        <button class="btn small" data-action="signout">Sign out</button>
      </div>
      ${p.banned ? '<p class="chip warn" style="margin-top:10px">Your account is suspended from posting.</p>' : ''}
      <details style="margin-top:10px"><summary class="muted small">How reputation works</summary>
        <ul class="small muted">
          <li>+5 for each price report, +2 for each feed post</li>
          <li>+2 when someone confirms your price, +1 per like</li>
          <li>−15 if the community hides your item; deleting your own item removes its points</li>
          <li>Flags from members with 30+ reputation count double, 100+ count triple</li>
        </ul>
      </details>
    </div>
    <div class="card"><h2>My price reports</h2><div id="my-reports"><p class="muted">Loading…</p></div></div>
    <div class="card"><h2>My feed posts</h2><div id="my-posts"><p class="muted">Loading…</p></div></div>
    ${state.isMod ? '<div class="card"><h2>Moderation queue</h2><div id="mod-queue"><p class="muted">Loading…</p></div></div>' : ''}
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
  if (state.isMod) renderModQueue();
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
        <div class="muted small">Hidden by ${esc(it.hiddenReason || '?')} · flag score ${it.flagScore || 0} · <span class="by" data-uid="${esc(it.uid)}">…</span></div>
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
    $('.by', row).textContent = `${u.displayName || 'Someone'} ★${u.reputation ?? 0}`;
    const flags = await getDocs(query(collection(db, 'flags'), where('targetType', '==', it.type), where('targetId', '==', it.id))).catch(() => null);
    $('.flag-reasons', row).textContent = flags?.docs.length
      ? flags.docs.map((f) => FLAG_REASONS[f.data().reason] + (f.data().note ? ` (“${f.data().note}”)` : '')).join(' · ')
      : 'No flags';
  });
}

function aboutCard() {
  return `
    <div class="card small muted">
      <b>About.</b> A crowdsourced index of what a plate of dal bhat costs across Nepal, inspired by fuel-price apps.
      Photo timestamps and locations are read on your device and stripped before upload. Report locations are public; feed posts only show the town.
      Elevations from <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a>; map © OpenStreetMap contributors.
    </div>`;
}

// ---------------------------------------------------------------- global actions
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'signin') return signIn();
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
$('#r-refills').checked = true;
refreshTownList();
renderMap();
loadReports();
