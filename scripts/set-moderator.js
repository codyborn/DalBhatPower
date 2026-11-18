#!/usr/bin/env node
/**
 * Grant or revoke moderator rights.
 *
 *   cd functions && npm install && cd ..
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/service-account.json \
 *     node scripts/set-moderator.js someone@gmail.com          # grant
 *     node scripts/set-moderator.js someone@gmail.com --revoke # revoke
 *
 * The user must sign out and back in (or wait up to an hour) for the claim to apply.
 */
const path = require('path');
const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));

async function main() {
  const [email, flag] = process.argv.slice(2);
  if (!email) {
    console.error('Usage: node scripts/set-moderator.js <email> [--revoke]');
    process.exit(1);
  }
  admin.initializeApp();
  const user = await admin.auth().getUserByEmail(email);
  const claims = { ...(user.customClaims || {}) };
  if (flag === '--revoke') delete claims.mod;
  else claims.mod = true;
  await admin.auth().setCustomUserClaims(user.uid, claims);
  console.log(`${flag === '--revoke' ? 'Revoked' : 'Granted'} moderator for ${email} (${user.uid})`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
