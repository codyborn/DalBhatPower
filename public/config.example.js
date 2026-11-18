// Copy this file to public/config.js and fill in your Firebase web app config
// (Firebase console → Project settings → Your apps → Web app → SDK setup and configuration).
// These values are not secrets; security comes from firestore.rules and storage.rules.
export const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  projectId: 'YOUR_PROJECT',
  storageBucket: 'YOUR_PROJECT.firebasestorage.app',
  messagingSenderId: '000000000000',
  appId: '1:000000000000:web:0000000000000000',
};

// Must match FUNCTIONS_REGION in functions/.env (and ideally your Firestore location).
export const functionsRegion = 'asia-south1';

// Set to true to talk to the local Firebase emulators (firebase emulators:start).
export const useEmulators = false;
