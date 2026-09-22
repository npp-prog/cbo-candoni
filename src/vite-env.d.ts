/// <reference types="vite/client" />

/**
 * Typed environment variables.
 *
 * Declaring them rather than reaching into `import.meta.env` untyped means a
 * misspelled variable name is a compile error instead of an `undefined` that
 * surfaces as a broken Firebase connection at runtime.
 */
interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN: string;
  readonly VITE_FIREBASE_PROJECT_ID: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID: string;
  readonly VITE_FIREBASE_APP_ID: string;
  readonly VITE_FIREBASE_FUNCTIONS_REGION?: string;
  readonly VITE_APPCHECK_SITE_KEY?: string;
  readonly VITE_APPCHECK_DEBUG?: string;
  readonly VITE_USE_EMULATORS?: string;
  readonly VITE_ENVIRONMENT?: 'development' | 'staging' | 'production';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
