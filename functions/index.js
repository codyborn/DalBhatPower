/**
 * Dal Bhat Index — Cloud Functions
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
} = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;

setGlobalOptions({
  region: process.env.FUNCTIONS_REGION || 'asia-south1',
  maxInstances: 10,
});

// ---------- tuning ----------
const POINTS = {
  report: 5,          // posting a menu-price report
  post: 2,            // posting to the feed
  confirmReceived: 2, // someone confirms your price
  likeReceived: 1,    // someone likes your meal photo
  hiddenByFlags: -15, // your item got auto-hidden by the community
  flagUpheld: 2,      // a moderator agreed with your flag
  flagRejected: -1,   // a moderator restored something you flagged
};
const HIDE_THRESHOLD = 3;          // weighted flag score that auto-hides an item
const MAX_REPORTS_PER_HOUR = 15;   // above this, new reports are held for review
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

async function deletePhoto(path) {
  if (!path) return;
  try {
    await admin.storage().bucket().file(path).delete({ ignoreNotFound: true });
  } catch (err) {
    logger.warn('Photo delete failed', { path, err: String(err) });
  }
}

// ---------- price reports ----------
exports.onReportCreated = onDocumentCreated('reports/{reportId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const r = snap.data();

  const recent = await countRecent('reports', r.uid);
  if (recent > MAX_REPORTS_PER_HOUR) {
    await snap.ref.update({ status: 'hidden', hiddenReason: 'rate-limit', repAwarded: 0 });
    await db.collection('modlog').add({
      action: 'auto-hide', reason: 'rate-limit', targetType: 'reports',
      targetId: snap.id, uid: r.uid, at: FieldValue.serverTimestamp(),
    });
    return;
  }

  const elevation = await lookupElevation(r.lat, r.lng);
  const batch = db.batch();
  batch.update(snap.ref, { elevation, repAwarded: POINTS.report });
  addReputation(r.uid, POINTS.report, batch);
  await batch.commit();
});

exports.onReportDeleted = onDocumentDeleted('reports/{reportId}', async (event) => {
  const r = event.data && event.data.data();
  if (!r) return;
  if (r.repAwarded) await addReputation(r.uid, -r.repAwarded);
  await deletePhoto(r.photoPath);
  // Clean up the confirms sub-collection.
  await db.recursiveDelete(db.collection(`reports/${event.params.reportId}/confirms`));
});

exports.onConfirmCreated = onDocumentCreated('reports/{reportId}/confirms/{uid}', async (event) => {
  const reportRef = db.doc(`reports/${event.params.reportId}`);
  await db.runTransaction(async (tx) => {
    const rep = await tx.get(reportRef);
    if (!rep.exists) return;
    tx.update(reportRef, { confirmCount: FieldValue.increment(1) });
    addReputation(rep.data().uid, POINTS.confirmReceived, tx);
  });
});

exports.onConfirmDeleted = onDocumentDeleted('reports/{reportId}/confirms/{uid}', async (event) => {
  const reportRef = db.doc(`reports/${event.params.reportId}`);
  await db.runTransaction(async (tx) => {
    const rep = await tx.get(reportRef);
    if (!rep.exists) return; // report itself was deleted
    tx.update(reportRef, { confirmCount: FieldValue.increment(-1) });
    addReputation(rep.data().uid, -POINTS.confirmReceived, tx);
  });
});

// ---------- feed posts ----------
exports.onPostCreated = onDocumentCreated('posts/{postId}', async (event) => {
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

exports.onPostDeleted = onDocumentDeleted('posts/{postId}', async (event) => {
  const p = event.data && event.data.data();
  if (!p) return;
  if (p.repAwarded) await addReputation(p.uid, -p.repAwarded);
  await deletePhoto(p.photoPath);
  await db.recursiveDelete(db.collection(`posts/${event.params.postId}/likes`));
});

exports.onLikeCreated = onDocumentCreated('posts/{postId}/likes/{uid}', async (event) => {
  const postRef = db.doc(`posts/${event.params.postId}`);
  await db.runTransaction(async (tx) => {
    const post = await tx.get(postRef);
    if (!post.exists) return;
    tx.update(postRef, { likeCount: FieldValue.increment(1) });
    addReputation(post.data().uid, POINTS.likeReceived, tx);
  });
});

exports.onLikeDeleted = onDocumentDeleted('posts/{postId}/likes/{uid}', async (event) => {
  const postRef = db.doc(`posts/${event.params.postId}`);
  await db.runTransaction(async (tx) => {
    const post = await tx.get(postRef);
    if (!post.exists) return;
    tx.update(postRef, { likeCount: FieldValue.increment(-1) });
    addReputation(post.data().uid, -POINTS.likeReceived, tx);
  });
});

// ---------- flags ----------
exports.onFlagCreated = onDocumentCreated('flags/{flagId}', async (event) => {
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
  if (action === 'remove') await deletePhoto(t.photoPath);
  return { ok: true };
});

/** setBanned({uid, banned: boolean}) — banned users can't post, confirm, like or flag. */
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
