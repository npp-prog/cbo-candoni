# Deployment

Municipal Government of Candoni — CBO

Two environments, two Firebase projects, one Netlify site with two deploy contexts.

| | Development | Production |
|---|---|---|
| Firebase project | `cbo-candoni-dev` | `cbo-candoni-prod` |
| Branch | `develop` | `main` |
| URL | `cbo-dev.mgocandoni.com` (or the Netlify branch URL) | `cbo.mgocandoni.com` |

Production data is never used for development. The header shows a bright environment banner on
anything that is not production, so a developer running a year-end close cannot mistake one for
the other.

---

## 1. Firebase projects

Create both projects in the Firebase console, then in each:

1. **Authentication** → enable Email/Password. Leave the rest off until GovMail SSO is configured.
2. **Firestore** → create the database in `asia-southeast1` (Singapore — closest region to Negros
   Occidental with full Firestore support). Start in **production mode**; the rules in this
   repository replace the defaults.
3. **Storage** → create the default bucket, same region.
4. **App Check** → register the web app with reCAPTCHA Enterprise. Add `cbo.mgocandoni.com` to the
   allowed domains. Leave enforcement **off** until the first deploy is confirmed working, then
   turn it on for Firestore, Storage and Cloud Functions.

Deploy the rules, indexes and functions:

```bash
firebase use cbo-candoni-dev
firebase deploy --only firestore:rules,firestore:indexes,storage:rules,functions

firebase use cbo-candoni-prod
firebase deploy --only firestore:rules,firestore:indexes,storage:rules,functions
```

The first functions deploy takes several minutes and will ask to enable the Cloud Build and
Artifact Registry APIs. Index creation is asynchronous — the Firestore console shows progress, and
queries that need an index return a `failed-precondition` error until it finishes building.

Then seed the reference data:

```bash
npx tsx scripts/seed.ts --project cbo-candoni-dev
npx tsx scripts/seed.ts --project cbo-candoni-prod
```

---

## 2. Netlify

Connect the GitHub repository. Build settings:

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Publish directory | `dist` |
| Node version | 20 (set in `netlify.toml`) |
| Production branch | `main` |

`netlify.toml` in the repository root already carries the SPA rewrite (`/* → /index.html` at status
200, so `cbo.mgocandoni.com/reports/trial-balance` loads when typed directly), the security
headers including HSTS, and the cache policy.

### Environment variables

Set these in **Site configuration → Environment variables**, scoped per deploy context. The
production values point at `cbo-candoni-prod`; the `develop` and deploy-preview contexts point at
`cbo-candoni-dev`.

```
VITE_FIREBASE_API_KEY
VITE_FIREBASE_AUTH_DOMAIN
VITE_FIREBASE_PROJECT_ID
VITE_FIREBASE_STORAGE_BUCKET
VITE_FIREBASE_MESSAGING_SENDER_ID
VITE_FIREBASE_APP_ID
VITE_FIREBASE_FUNCTIONS_REGION=asia-southeast1
VITE_APPCHECK_SITE_KEY
VITE_ENVIRONMENT=production        # or "staging" on the develop context
```

**On the Firebase web config being "public":** it is, and that is fine. It identifies the project;
it is not a credential, and it is visible in any built bundle. What protects municipal financial
data is Authentication + Security Rules + App Check + server-side authorisation. Treating the web
config as a secret produces a false sense of security and tempts people into genuinely dangerous
workarounds — putting an Admin SDK service account in the frontend "to avoid exposing config" would
hand every visitor unrestricted access to the entire database. A service account key must never
appear in this repository, in Netlify environment variables, or anywhere the frontend can reach.

---

## 3. DNS — the Squarespace change

`mgocandoni.com` stays exactly as it is. One record is added.

In the DNS provider managing `mgocandoni.com` (Squarespace):

| Type | Host | Value |
|---|---|---|
| CNAME | `cbo` | `candoni-books-online.netlify.app` |

Use the actual Netlify site domain as the target, and do **not** include `https://` in the value.
Nothing about the root domain, the `www` record, or the existing Squarespace records changes. The
municipal website continues to serve from Squarespace untouched.

In Netlify, **Domain management → Add a domain** → `cbo.mgocandoni.com`, set as the production
domain. Netlify verifies the CNAME, provisions a Let's Encrypt certificate automatically, and
enables the HTTP→HTTPS redirect. Propagation is usually minutes; allow up to an hour.

Then add `cbo.mgocandoni.com` to **Firebase Authentication → Settings → Authorised domains**, or
sign-in will be refused from the production URL.

The same pattern extends to the other municipal systems — `pms`, `ims`, `abo`, and eventually
`portal` — each its own CNAME, each its own Netlify site, the root domain never touched.

---

## 4. Verifying a deployment

After the first production deploy, before anyone records a real transaction:

1. `https://cbo.mgocandoni.com` loads and redirects from `http://`.
2. A deep link typed directly — `/reports/trial-balance` — loads rather than 404ing.
3. The environment banner is **absent** (it appears only when `VITE_ENVIRONMENT` is not
   `production`).
4. Sign in. A new account with no roles must show "Awaiting access" and nothing else.
5. Grant yourself `SUPER_ADMIN` through the functions shell, sign out and in again.
6. Master Data → Chart of Accounts shows the seeded accounts.
7. Record an appropriation, approve it, release an allotment, raise an obligation for **more** than
   the allotment. The certification must be refused, with the shortfall named in the message. This
   single test proves the whole server-side control chain is live.
8. Turn on App Check enforcement for Firestore, Storage and Functions.
9. Confirm the nightly scheduled functions appear under Cloud Scheduler.

---

## 5. Branching and release

```
feature/disbursement ──┐
feature/payroll ───────┼──► develop ──► main
feature/saob ──────────┘     staging    production
```

CI runs on every push and pull request to `main` and `develop`: typecheck, the invariant tests, a
production build, the Cloud Functions build, the vendored-rules equality check, and a syntax check
on both rules files. A pull request that fails any of these does not merge.

Rules and functions deploy separately from the frontend, and **deploy first**. Netlify ships the
new UI in about a minute; if the UI expects a function that has not been deployed, users see
errors in between. Rules and functions are backward compatible with the previous UI by
construction — the engine never removes a callable in the same release that stops using it.

---

## 6. Backup and recovery

Firestore's scheduled exports to Cloud Storage are the backup of record:

```bash
gcloud firestore export gs://cbo-candoni-prod-backups/$(date +%Y-%m-%d) \
  --project cbo-candoni-prod
```

Schedule this daily through Cloud Scheduler. Retain daily for 30 days, weekly for a year, and the
year-end export permanently — a fiscal year's books must remain retrievable for as long as COA may
ask for them.

Cloud Storage documents are backed up separately; enable Object Versioning on the bucket so a
deleted or replaced file can be recovered.

Test a restore into `cbo-candoni-dev` at least once a year. A backup that has never been restored
is a hypothesis, not a backup.
