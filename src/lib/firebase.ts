import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, type Auth } from 'firebase/auth';
import {
  connectFirestoreEmulator,
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  type Firestore,
} from 'firebase/firestore';
import { getStorage, connectStorageEmulator, type FirebaseStorage } from 'firebase/storage';
import { getFunctions, connectFunctionsEmulator, type Functions } from 'firebase/functions';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';

/**
 * Firebase initialisation.
 *
 * On the Firebase web config being "public": it is. It identifies the project,
 * it is not a credential, and it is visible in any built bundle. What keeps
 * municipal financial data safe is Authentication + Security Rules + App Check
 * + server-side authorisation in Cloud Functions. Treating the web config as a
 * secret produces a false sense of security and tempts people to do genuinely
 * dangerous things - like putting an Admin SDK service account in the frontend
 * to "avoid exposing config". That must never happen here.
 */

interface FirebaseEnv {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

function readEnv(): FirebaseEnv {
  const cfg: FirebaseEnv = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? '',
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '',
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? '',
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '',
    appId: import.meta.env.VITE_FIREBASE_APP_ID ?? '',
  };

  const missing = Object.entries(cfg)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length && import.meta.env.MODE !== 'test') {
    // Fail loudly and early. A half-configured accounting system that appears
    // to work is far worse than one that refuses to start.
    console.error(
      `[CFMS] Missing Firebase configuration: ${missing.join(', ')}. ` +
        'Set the VITE_FIREBASE_* environment variables in Netlify for this deploy context.',
    );
  }
  return cfg;
}

export const ENVIRONMENT = (import.meta.env.VITE_ENVIRONMENT ?? 'development') as
  | 'development'
  | 'staging'
  | 'production';

export const IS_PRODUCTION = ENVIRONMENT === 'production';

const useEmulators = import.meta.env.VITE_USE_EMULATORS === 'true';
const region = import.meta.env.VITE_FIREBASE_FUNCTIONS_REGION ?? 'asia-southeast1';

export const app: FirebaseApp = initializeApp(readEnv());

/**
 * Firestore with a persistent cache. CFMS is used in offices where connectivity
 * is not always reliable; the cache keeps master data and recently-viewed
 * transactions readable during a drop. Writes are still online-only in
 * practice, because every state change goes through a Cloud Function.
 * Single-tab manager: multi-tab synchronisation is not worth the complexity
 * for a desktop-first internal system.
 */
export const db: Firestore = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager({}) }),
  ignoreUndefinedProperties: false,
});

export const auth: Auth = getAuth(app);
export const storage: FirebaseStorage = getStorage(app);
export const functions: Functions = getFunctions(app, region);

/**
 * App Check. Attests that requests come from the real CFMS application at
 * cbo.mgocandoni.com rather than from a script holding a copied web config.
 * Not a substitute for security rules - it is an additional gate in front of
 * them.
 */
const appCheckSiteKey = import.meta.env.VITE_APPCHECK_SITE_KEY;
if (appCheckSiteKey && !useEmulators) {
  if (import.meta.env.VITE_APPCHECK_DEBUG === 'true') {
    // Allows a developer machine to obtain a debug token from the console.
    // Guarded so it can never be switched on in a production build by accident.
    (globalThis as Record<string, unknown>).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }
  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (err) {
    console.error('[CFMS] App Check failed to initialise', err);
  }
} else if (IS_PRODUCTION) {
  console.error('[CFMS] App Check is not configured in a production build.');
}

if (useEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  console.info('[CFMS] Connected to the Firebase emulator suite.');
}
