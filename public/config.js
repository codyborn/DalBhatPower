// Firebase web app config for project dalbhatpower-fa19c.
// These values are public identifiers, not secrets; access is enforced by
// firestore.rules and storage.rules.
export const firebaseConfig = {
  apiKey: 'AIzaSyBhz7B0svouNrCbUDUZIBduUiIZAzeIoGk',
  authDomain: 'dalbhatpower-fa19c.firebaseapp.com',
  projectId: 'dalbhatpower-fa19c',
  storageBucket: 'dalbhatpower-fa19c.firebasestorage.app',
  messagingSenderId: '298322962959',
  appId: '1:298322962959:web:652fef80c5af72ff30917a',
  measurementId: 'G-TP5PCGZ8TK',
};

// Firestore database ID — matches FIRESTORE_DATABASE in functions/.env and "database" in firebase.json.
export const firestoreDatabase = 'dalbhatdb';

// Must match FUNCTIONS_REGION in functions/.env (the Firestore database's location).
export const functionsRegion = 'asia-south1';

// Set to true to talk to the local Firebase emulators (firebase emulators:start).
export const useEmulators = false;
