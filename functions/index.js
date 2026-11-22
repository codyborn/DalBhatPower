/**
 * Dal Bhat Power — Cloud Functions
 *
 * Everything a client must not be trusted with lives here:
 *   - reputation points
 *   - confirm / like / flag counters
 *   - auto-hiding content once enough weighted flags arrive
 *   - elevation lookup for each price report (Open-Meteo, no API key)
 *   - a simple per-user rate limit
 *   - moderator actions (callable)
 */
const { setGlobalOptions } = require('firebase-functions/v2');
const {
  onDocumentCreated,
  onDocumentDeleted,
  onDocumentUpdated,
} = require('firebase-functions/v2/firestore');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

// Named Firestore database (set FIRESTORE_DATABASE in functions/.env; "(default)" if unnamed).
const DATABASE_ID = process.env.FIRESTORE_DATABASE || '(default)';

admin.initializeApp();
const db = getFirestore(DATABASE_ID);

/** Trigger options bound to our database. */
const on = (document) => ({ document, database: DATABASE_ID });

setGlobalOptions({
  region: process.env.FUNCTIONS_REGION || 'asia-south1',
  maxInstances: 10,
});

// ---------- tuning ----------
const POINTS = {
  report: 5,          // posting a menu-price report (first plate on a photo)
  extraPlate: 1,      // each additional plate priced from the same menu photo
  post: 2,            // posting to the feed
  confirmReceived: 2, // someone confirms your price
  likeReceived: 1,    // someone likes your meal photo
  hiddenByFlags: -15, // your item got auto-hidden by the community
  flagUpheld: 2,      // a moderator agreed with your flag
  flagRejected: -1,   // a moderator restored something you flagged
};
const HIDE_THRESHOLD = 3;          // weighted flag score that auto-hides an item
const MAX_REPORTS_PER_HOUR = 40;   // plates per hour; above this, new reports are held for review
const MAX_POSTS_PER_HOUR = 10;

/** Flag weight grows with reputation, so trusted users can clear spam faster. */
function flagWeight(reputation) {
  if (reputation >= 100) return 3;
  if (reputation >= 30) return 2;
  return 1;
}

function addReputation(uid, delta, batchOrTx) {
  if (!uid || !delta) return;
  const ref = db.doc(`users/${uid}`);
  const update = { reputation: FieldValue.increment(delta) };
  if (batchOrTx) batchOrTx.set(ref, update, { merge: true });
  else return ref.set(update, { merge: true });
}

async function lookupElevation(lat, lng) {
  try {
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const m = Array.isArray(json.elevation) ? json.elevation[0] : null;
    return typeof m === 'number' && Number.isFinite(m) ? Math.round(m) : null;
  } catch (err) {
    logger.warn('Elevation lookup failed', { lat, lng, err: String(err) });
    return null;
  }
}

async function countRecent(collection, uid) {
  const since = Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);
  const snap = await db
    .collection(collection)
    .where('uid', '==', uid)
    .where('createdAt', '>=', since)
    .count()
    .get();
  return snap.data().count;
}

/** Several plate reports can share one menu photo: only delete it when none still use it. */
async function deleteReportPhotoIfUnused(path, exceptId) {
  if (!path) return;
  const others = await db.collection('reports').where('photoPath', '==', path).limit(2).get();
  const stillUsed = others.docs.some((d) => d.id !== exceptId && d.data().status !== 'removed');
  if (!stillUsed) await deletePhoto(path);
}

async function deletePhoto(path) {
  if (!path) return;
  try {
    await admin.storage().bucket().file(path).delete({ ignoreNotFound: true });
  } catch (err) {
    logger.warn('Photo delete failed', { path, err: String(err) });
  }
}

// ---------- price reports ----------
exports.onReportCreated = onDocumentCreated(on('reports/{reportId}'), async (event) => {
  const snap = event.data;
  if (!snap) return;
  const r = snap.data();

  let recent = 0;
  try {
    recent = await countRecent('reports', r.uid);
  } catch (err) {
    // e.g. index still building — don't let the rate limit block the elevation lookup
    logger.error('Rate-limit count failed', { err: String(err) });
  }
  if (recent > MAX_REPORTS_PER_HOUR) {
    await snap.ref.update({ status: 'hidden', hiddenReason: 'rate-limit', repAwarded: 0 });
    await db.collection('modlog').add({
      action: 'auto-hide', reason: 'rate-limit', targetType: 'reports',
      targetId: snap.id, uid: r.uid, at: FieldValue.serverTimestamp(),
    });
    return;
  }

  const elevation = await lookupElevation(r.lat, r.lng);
  logger.info('Report created', { id: snap.id, elevation });
  const points = r.plateIndex > 0 ? POINTS.extraPlate : POINTS.report;
  const batch = db.batch();
  batch.update(snap.ref, { elevation, repAwarded: points });
  addReputation(r.uid, points, batch);
  await batch.commit();
});

exports.onReportDeleted = onDocumentDeleted(on('reports/{reportId}'), async (event) => {
  const r = event.data && event.data.data();
  if (!r) return;
  if (r.repAwarded) await addReputation(r.uid, -r.repAwarded);
  await deleteReportPhotoIfUnused(r.photoPath, event.params.reportId);
  // Clean up the confirms sub-collection.
  await db.recursiveDelete(db.collection(`reports/${event.params.reportId}/confirms`));
});

/**
 * When an owner changes a report's price or plate, the existing "I paid this too" confirmations
 * no longer vouch for it: remove them (onConfirmDeleted then adjusts the count and reputation).
 */
exports.onReportUpdated = onDocumentUpdated(on('reports/{reportId}'), async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (!before || !after) return;
  if (before.priceNpr === after.priceNpr && before.meal === after.meal) return;
  const confirms = await db.collection(`reports/${event.params.reportId}/confirms`).get();
  if (confirms.empty) return;
  const batch = db.batch();
  confirms.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  logger.info('Cleared confirmations after edit', { id: event.params.reportId, n: confirms.size });
});

exports.onConfirmCreated = onDocumentCreated(on('reports/{reportId}/confirms/{uid}'), async (event) => {
  const reportRef = db.doc(`reports/${event.params.reportId}`);
  await db.runTransaction(async (tx) => {
    const rep = await tx.get(reportRef);
    if (!rep.exists) return;
    tx.update(reportRef, { confirmCount: FieldValue.increment(1) });
    addReputation(rep.data().uid, POINTS.confirmReceived, tx);
  });
});

exports.onConfirmDeleted = onDocumentDeleted(on('reports/{reportId}/confirms/{uid}'), async (event) => {
  const reportRef = db.doc(`reports/${event.params.reportId}`);
  await db.runTransaction(async (tx) => {
    const rep = await tx.get(reportRef);
    if (!rep.exists) return; // report itself was deleted
    tx.update(reportRef, { confirmCount: FieldValue.increment(-1) });
    addReputation(rep.data().uid, -POINTS.confirmReceived, tx);
  });
});

// ---------- feed posts ----------
exports.onPostCreated = onDocumentCreated(on('posts/{postId}'), async (event) => {
  const snap = event.data;
  if (!snap) return;
  const p = snap.data();
  const recent = await countRecent('posts', p.uid);
  if (recent > MAX_POSTS_PER_HOUR) {
    await snap.ref.update({ status: 'hidden', hiddenReason: 'rate-limit', repAwarded: 0 });
    return;
  }
  const batch = db.batch();
  batch.update(snap.ref, { repAwarded: POINTS.post });
  addReputation(p.uid, POINTS.post, batch);
  await batch.commit();
});

exports.onPostDeleted = onDocumentDeleted(on('posts/{postId}'), async (event) => {
  const p = event.data && event.data.data();
  if (!p) return;
  if (p.repAwarded) await addReputation(p.uid, -p.repAwarded);
  await deletePhoto(p.photoPath);
  await db.recursiveDelete(db.collection(`posts/${event.params.postId}/likes`));
});

exports.onLikeCreated = onDocumentCreated(on('posts/{postId}/likes/{uid}'), async (event) => {
  const postRef = db.doc(`posts/${event.params.postId}`);
  await db.runTransaction(async (tx) => {
    const post = await tx.get(postRef);
    if (!post.exists) return;
    tx.update(postRef, { likeCount: FieldValue.increment(1) });
    addReputation(post.data().uid, POINTS.likeReceived, tx);
  });
});

exports.onLikeDeleted = onDocumentDeleted(on('posts/{postId}/likes/{uid}'), async (event) => {
  const postRef = db.doc(`posts/${event.params.postId}`);
  await db.runTransaction(async (tx) => {
    const post = await tx.get(postRef);
    if (!post.exists) return;
    tx.update(postRef, { likeCount: FieldValue.increment(-1) });
    addReputation(post.data().uid, -POINTS.likeReceived, tx);
  });
});

// ---------- flags ----------
exports.onFlagCreated = onDocumentCreated(on('flags/{flagId}'), async (event) => {
  const f = event.data && event.data.data();
  if (!f) return;
  const targetRef = db.doc(`${f.targetType}/${f.targetId}`);
  const flaggerRef = db.doc(`users/${f.uid}`);

  await db.runTransaction(async (tx) => {
    const [target, flagger] = await Promise.all([tx.get(targetRef), tx.get(flaggerRef)]);
    if (!target.exists) return;
    const t = target.data();
    const weight = flagWeight((flagger.exists && flagger.data().reputation) || 0);
    const newScore = (t.flagScore || 0) + weight;
    const update = { flagScore: newScore };

    if (t.status === 'visible' && newScore >= HIDE_THRESHOLD) {
      update.status = 'hidden';
      update.hiddenReason = 'flags';
      update.hiddenAt = FieldValue.serverTimestamp();
      addReputation(t.uid, POINTS.hiddenByFlags, tx);
      tx.set(db.collection('modlog').doc(), {
        action: 'auto-hide', reason: 'flags', targetType: f.targetType,
        targetId: f.targetId, uid: t.uid, flagScore: newScore,
        at: FieldValue.serverTimestamp(),
      });
    }
    tx.update(targetRef, update);
  });
});

// ---------- feedback ----------
const MAX_FEEDBACK_PER_HOUR = 5;
exports.onFeedbackCreated = onDocumentCreated(on('feedback/{feedbackId}'), async (event) => {
  const snap = event.data;
  if (!snap) return;
  const f = snap.data();
  let recent = 0;
  try { recent = await countRecent('feedback', f.uid); } catch (err) { logger.error('Feedback count failed', { err: String(err) }); }
  if (recent > MAX_FEEDBACK_PER_HOUR) {
    await snap.ref.delete();
    logger.warn('Feedback rate-limited', { uid: f.uid });
    return;
  }
  logger.info('New feedback', { id: snap.id, kind: f.kind });
});

// ---------- elevation self-repair (callable) ----------
/**
 * fillElevation({reportId}) — any signed-in user's browser calls this when it shows a
 * report that still has no elevation (e.g. the lookup failed at creation time).
 */
exports.fillElevation = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const id = request.data && request.data.reportId;
  if (typeof id !== 'string' || !/^[A-Za-z0-9]{1,40}$/.test(id)) {
    throw new HttpsError('invalid-argument', 'Bad report id.');
  }
  const ref = db.doc(`reports/${id}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such report.');
  const r = snap.data();
  if (typeof r.elevation === 'number') return { elevation: r.elevation };
  const elevation = await lookupElevation(r.lat, r.lng);
  if (elevation != null) await ref.update({ elevation });
  return { elevation };
});

// ---------- moderator tools (callable) ----------
function requireMod(request) {
  if (!request.auth || request.auth.token.mod !== true) {
    throw new HttpsError('permission-denied', 'Moderators only.');
  }
}

async function flaggersOf(targetType, targetId) {
  const snap = await db
    .collection('flags')
    .where('targetType', '==', targetType)
    .where('targetId', '==', targetId)
    .get();
  return snap.docs.map((d) => d.data().uid);
}

/**
 * moderate({targetType: 'reports'|'posts', targetId, action: 'hide'|'restore'|'remove'})
 *  hide    – take it down pending review
 *  restore – put it back; refunds the author if flags hid it; flaggers lose a point
 *  remove  – permanent; photo deleted; flaggers gain points
 */
exports.moderate = onCall(async (request) => {
  requireMod(request);
  const { targetType, targetId, action } = request.data || {};
  if (!['reports', 'posts'].includes(targetType) || typeof targetId !== 'string') {
    throw new HttpsError('invalid-argument', 'Bad target.');
  }
  if (!['hide', 'restore', 'remove'].includes(action)) {
    throw new HttpsError('invalid-argument', 'Bad action.');
  }
  const ref = db.doc(`${targetType}/${targetId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such item.');
  const t = snap.data();
  const batch = db.batch();
  const flaggers = await flaggersOf(targetType, targetId);

  if (action === 'hide') {
    batch.update(ref, { status: 'hidden', hiddenReason: 'mod', hiddenAt: FieldValue.serverTimestamp() });
  } else if (action === 'restore') {
    batch.update(ref, { status: 'visible', hiddenReason: FieldValue.delete(), flagScore: 0 });
    if (t.hiddenReason === 'flags') addReputation(t.uid, -POINTS.hiddenByFlags, batch);
    flaggers.forEach((uid) => addReputation(uid, POINTS.flagRejected, batch));
  } else if (action === 'remove') {
    batch.update(ref, { status: 'removed', removedAt: FieldValue.serverTimestamp() });
    if (t.hiddenReason !== 'flags') addReputation(t.uid, POINTS.hiddenByFlags, batch);
    flaggers.forEach((uid) => addReputation(uid, POINTS.flagUpheld, batch));
  }
  batch.set(db.collection('modlog').doc(), {
    action, targetType, targetId, uid: t.uid, by: request.auth.uid,
    at: FieldValue.serverTimestamp(),
  });
  await batch.commit();
  if (action === 'remove') {
    if (targetType === 'reports') await deleteReportPhotoIfUnused(t.photoPath, targetId);
    else await deletePhoto(t.photoPath);
  }
  return { ok: true };
});

/** setBanned({uid, banned: boolean}) — banned users can't post, confirm, like or flag (moderators only). */
exports.setBanned = onCall(async (request) => {
  requireMod(request);
  const { uid, banned } = request.data || {};
  if (typeof uid !== 'string' || typeof banned !== 'boolean') {
    throw new HttpsError('invalid-argument', 'Bad arguments.');
  }
  await db.doc(`users/${uid}`).set({ banned }, { merge: true });
  await db.collection('modlog').add({
    action: banned ? 'ban' : 'unban', uid, by: request.auth.uid,
    at: FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

// ---------- crawlable pages: /town/{key}, /towns, /sitemap.xml (see seo.js) ----------
exports.seo = onRequest({ memory: '256MiB', maxInstances: 5, concurrency: 40 }, require('./seo').handler(db, Timestamp));
