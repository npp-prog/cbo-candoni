# CFMS deployment runbook

Municipal Government of Candoni — from an empty GitHub account to live books at
`https://cbo.mgocandoni.com`.

Work through the phases in order. Each ends with a **checkpoint** — do not start the next phase
until it passes. Phases 1–6 are safe to repeat; phase 8 changes public DNS and phase 10 creates
the municipality's real opening balances, so both are done once, carefully.

**Realistic timeline.** Phases 0–6 in a day or two. Phase 7–9 in an afternoon. Phase 10 (opening
balances) depends entirely on how clean the existing records are — budget a week and expect the
Accountant to spend real time on it. Phase 11 is a full month of parallel running.

---

## Phase 0 — Before you start

### 0.1 Accounts and access

| What | Who needs it | Notes |
|---|---|---|
| GitHub account with a new repository | You | Free tier is fine |
| Google account for Firebase | The municipality, not a personal account | Use an official address; this account owns the data |
| Firebase Blaze (pay-as-you-go) plan | The municipality | **Required** — Cloud Functions do not run on Spark |
| Netlify account | You | Free tier is sufficient at this scale |
| Squarespace DNS access for `mgocandoni.com` | You or whoever manages the website | One CNAME will be added |

**On the Blaze plan.** Cloud Functions require it. For a municipality of Candoni's transaction
volume the monthly bill is typically a few US dollars — Firestore reads dominate, and the free
tier covers most of them. Set a budget alert at ₱2,000/month in the Google Cloud console so a
runaway loop cannot produce a surprise.

### 0.2 Local tools

```bash
node --version      # must be 20.x — Cloud Functions target Node 20
npm --version
git --version
npm install -g firebase-tools
firebase login
```

If `node --version` is not 20.x, install it via nvm. Building against 22 and deploying to 20
produces failures that are hard to read.

### 0.3 Decisions the municipality must make first

These cannot be deferred — they shape the data:

1. **Which fiscal year does CFMS start recording?** Mid-year start is normal but means opening
   balances (phase 10).
2. **Who is the first Super Administrator?** One named person. Not a shared account.
3. **Which funds are in scope at go-live?** General Fund only is a sensible first step; SEF and
   Trust Fund can follow.
4. **Are the seeded withholding tax rates current?** Check the prevailing BIR issuance. A wrong
   rate leaves the municipality liable for the shortfall.

Write the answers down. Phase 10 depends on all four.

---

## Phase 1 — GitHub repository

```bash
unzip cbo-candoni.zip
cd cbo-candoni

git init
git add .
git commit -m "CFMS — initial system"
git branch -M main
git remote add origin https://github.com/<your-org>/cbo-candoni.git
git push -u origin main

git checkout -b develop
git push -u origin develop
```

In GitHub → **Settings → Branches**, protect `main`: require a pull request, and require the CI
status checks to pass. This is what stops a change that breaks a control from reaching production.

**Checkpoint 1.** The Actions tab shows a green run for `main`: frontend typecheck/test/build,
Cloud Functions build/test, and the security-rule invariant checks.

---

## Phase 2 — Firebase development project

### 2.1 Create the project

Firebase console → **Add project** → name it `cbo-candoni-dev`. Disable Google Analytics (not
useful here, and it adds a data-sharing consideration for no benefit). Upgrade to **Blaze**.

### 2.2 Enable the services

| Service | Setting |
|---|---|
| **Authentication** | Sign-in method → enable **Email/Password**. Nothing else yet. |
| **Firestore** | Create database → **production mode** → location `asia-southeast1` (Singapore) |
| **Storage** | Get started → **production mode** → same location |

Both must be `asia-southeast1` — it is the closest region with full Firestore support, and the
location cannot be changed afterwards without recreating the project.

"Production mode" means deny-all by default. The rules in this repository replace that.

### 2.3 Register the web app

Project settings → **Your apps** → Web (`</>`) → nickname `CFMS Web`. Do **not** tick Firebase
Hosting — this project deploys to Netlify.

Copy the config object. You need six values:

```
apiKey  authDomain  projectId  storageBucket  messagingSenderId  appId
```

### 2.4 Point the CLI at the project

```bash
firebase use --add
# select cbo-candoni-dev, alias it "dev"
```

**Checkpoint 2.** `firebase projects:list` shows the project, and `firebase use` reports `dev`.

---

## Phase 3 — Run it locally against the emulators

This proves the code works before any cloud resource is involved.

```bash
npm install
npm --prefix functions install

cp .env.example .env.local
```

Edit `.env.local` — for emulator work the Firebase values can be placeholders, but
`VITE_USE_EMULATORS` must be `true`:

```
VITE_FIREBASE_API_KEY=local
VITE_FIREBASE_AUTH_DOMAIN=localhost
VITE_FIREBASE_PROJECT_ID=cbo-candoni-dev
VITE_FIREBASE_STORAGE_BUCKET=cbo-candoni-dev.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=000000000000
VITE_FIREBASE_APP_ID=local
VITE_FIREBASE_FUNCTIONS_REGION=asia-southeast1
VITE_USE_EMULATORS=true
VITE_ENVIRONMENT=development
```

Verify the whole build first:

```bash
npm run verify
```

That runs the rule invariant checks, typecheck, the accounting tests, a production build, the
functions build and the functions tests. All six must pass.

Then, in **two terminals**:

```bash
# Terminal 1
npm run functions:build
npm run emulators              # UI at http://127.0.0.1:4000

# Terminal 2
npx tsx scripts/seed.ts --project cbo-candoni-dev --emulator
npm run dev                    # app at http://localhost:5173
```

Create a test user: emulator UI → Authentication → **Add user**, any email and password. Sign in
to CFMS — you should see **"Awaiting access"** and nothing else. That is correct.

Grant yourself the administrator role:

```bash
firebase emulators:exec --only functions,firestore,auth \
  "firebase functions:shell" --project cbo-candoni-dev
```

Simpler, while the emulators are already running, use the emulator UI: Authentication → your user
→ **Custom claims** → set:

```json
{ "roles": ["SUPER_ADMIN"], "officeScope": [], "fundScope": [], "active": true }
```

Sign out and in again.

**Checkpoint 3.** The dashboard loads. Master Data → Chart of Accounts shows the seeded accounts.
Now run **the test that matters**:

1. Budget → Appropriations → record ₱1,000,000 against any office and MOOE account → Approve.
2. Budget → Allotments → release ₱500,000 against **the same office and account** → Release.
3. Budget → Obligations → New → same office and account, amount **₱600,000** → Save → Certify.

The certification must be **refused**, with a message naming the line and the shortfall
(₱100,000). If it succeeds, stop — the server-side control chain is not working, and nothing
downstream can be trusted.

Then reduce to ₱400,000 and certify: it should succeed and assign an OBR number like
`100-26-09-0001`.

---

## Phase 4 — Deploy the backend to development

```bash
firebase use dev
firebase deploy --only firestore:rules,firestore:indexes,storage:rules,functions
```

The first functions deploy takes 5–10 minutes and asks to enable Cloud Build and Artifact
Registry — accept. Index creation is asynchronous; watch **Firestore → Indexes** until all show
*Enabled*. Queries needing an unbuilt index fail with `failed-precondition` until then.

Seed the real dev database:

```bash
npx tsx scripts/seed.ts --project cbo-candoni-dev
```

**Checkpoint 4.** Firebase console shows: Firestore rules updated, ~40 composite indexes enabled,
19 functions deployed in `asia-southeast1`, and `funds`, `accounts`, `offices`, `taxCodes`,
`numberingRules` and `settings` populated.

---

## Phase 5 — Netlify staging site

### 5.1 Create the site

Netlify → **Add new site → Import an existing project** → GitHub → `cbo-candoni`.

| Setting | Value |
|---|---|
| Branch to deploy | `develop` |
| Build command | `npm run build` |
| Publish directory | `dist` |

`netlify.toml` already supplies the Node version, the SPA rewrite and the security headers.

### 5.2 Environment variables

**Site configuration → Environment variables.** Add each with scope **Branch deploys and deploy
previews** (not production yet), using the `cbo-candoni-dev` values:

```
VITE_FIREBASE_API_KEY               <dev apiKey>
VITE_FIREBASE_AUTH_DOMAIN           cbo-candoni-dev.firebaseapp.com
VITE_FIREBASE_PROJECT_ID            cbo-candoni-dev
VITE_FIREBASE_STORAGE_BUCKET        cbo-candoni-dev.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID   <dev sender id>
VITE_FIREBASE_APP_ID                <dev appId>
VITE_FIREBASE_FUNCTIONS_REGION      asia-southeast1
VITE_ENVIRONMENT                    staging
```

Note the site's Netlify domain — something like `candoni-books-online.netlify.app`. You need it in
phase 8.

### 5.3 Authorise the domain

Firebase console (`cbo-candoni-dev`) → Authentication → Settings → **Authorised domains** → add
your Netlify domain, including the `develop--` branch prefix if you use branch deploys.

Trigger a deploy:

```bash
git checkout develop
git commit --allow-empty -m "Trigger staging deploy"
git push
```

**Checkpoint 5.** The staging URL loads with an **amber "STAGING environment" banner** across the
top. Sign-in works. Repeat the over-allotment test from checkpoint 3 against the real dev backend.

---

## Phase 6 — User acceptance testing

Do this with the Municipal Accountant, the Budget Officer and the Treasurer, on staging, before
production exists. Two or three hours.

Create one user per role in the dev project (Authentication → Add user), then grant roles through
**Administration → Users and Roles**.

Walk the full chain and confirm each refusal:

| # | Step | Expected |
|---|---|---|
| 1 | Budget Officer records and approves an appropriation | Available for allotment |
| 2 | Budget Staff drafts an allotment exceeding it | **Refused**, shortfall named |
| 3 | Budget Officer releases a valid allotment | OBR numbering begins |
| 4 | Department User raises an obligation for another office | Office not selectable |
| 5 | Budget Officer certifies beyond the allotment **with override** | Reason demanded; OBR flagged "Over allotment"; critical audit event |
| 6 | Encoder drafts a DV with no attachment, submits | **Refused** — supporting documents required |
| 7 | Encoder attaches an invoice, submits | Goes to reviewer |
| 8 | **The same encoder** tries to approve it | **Refused** — segregation of duties |
| 9 | Reviewer reviews; Accountant approves | DV numbered; JEV generated in DRAFT |
| 10 | Accountant posts the JEV | Ledger entries written; DV becomes Paid |
| 11 | Anyone tries to edit the posted JEV | Read-only |
| 12 | Accountant reverses it with a reason | Mirror entry posted; both visible in the ledger |
| 13 | Treasurer issues a check, then reuses the number | **Refused** — duplicate check number |
| 14 | Treasury records collections → RCD → posts → deposit | Cash position updates |
| 15 | Import a bank statement CSV twice | Second import reports duplicates skipped |
| 16 | Run auto-match, then finalise with a non-zero difference | **Refused** — must be exactly zero |
| 17 | Accountant closes the period with an unposted JEV | **Refused**, names the JEV |
| 18 | Post it, close the period, try to post into that month | **Refused** |
| 19 | Reopen the period | 15-character reason demanded; reopening count shown |
| 20 | Reports → Trial Balance | Foots exactly |
| 21 | Print any report | Official heading, no navigation chrome |
| 22 | Audit Trail → critical events | Override, reversal, reopening all present |

**Checkpoint 6.** Every refusal above actually refuses, and the three officers sign off. Record
any change requests now — after phase 10 the cost of a data-model change rises sharply.

---

## Phase 7 — Firebase production project

Repeat phase 2 exactly, with the name `cbo-candoni-prod`. Same region, same services, same web app
registration. Keep the two config objects clearly separated — mixing them is the single most
expensive mistake available at this stage.

```bash
firebase use --add            # select cbo-candoni-prod, alias "prod"
firebase use prod
firebase deploy --only firestore:rules,firestore:indexes,storage:rules,functions
npx tsx scripts/seed.ts --project cbo-candoni-prod
```

### 7.1 Lock down IAM

Google Cloud console → **IAM & Admin** for `cbo-candoni-prod`. A project Owner can edit Firestore
directly, bypassing every rule and every function. Restrict Owner to one or two people. Everyone
else who needs console visibility gets **Viewer**.

**Checkpoint 7.** Both aliases resolve (`firebase use dev`, `firebase use prod`), production has
all indexes enabled and all functions deployed, and the IAM list is short.

---

## Phase 8 — Production domain and DNS

> This phase changes public DNS. Do it during working hours when the Squarespace account holder is
> reachable. Nothing about the existing municipal website changes.

### 8.1 Netlify production context

Site configuration → Environment variables → add the **same eight variables again**, this time
scoped to **Production**, with the `cbo-candoni-prod` values and:

```
VITE_ENVIRONMENT                    production
```

Build & deploy → set the **production branch** to `main`.

### 8.2 Add the custom domain

Netlify → **Domain management → Add a domain** → `cbo.mgocandoni.com`. Netlify will say DNS is not
yet configured and show the target — copy it exactly (e.g. `candoni-books-online.netlify.app`).

### 8.3 The one DNS record

Squarespace → **Settings → Domains → mgocandoni.com → DNS Settings → Add record**:

| Field | Value |
|---|---|
| Type | `CNAME` |
| Host | `cbo` |
| Data / Value | `candoni-books-online.netlify.app` |

Do **not** include `https://`. Do **not** add a trailing dot unless Squarespace requires it. Touch
no other record — the root domain, `www`, MX and verification records all stay exactly as they are.

Check propagation:

```bash
dig cbo.mgocandoni.com CNAME +short
```

Usually minutes; allow up to an hour.

### 8.4 HTTPS

Once Netlify verifies the CNAME it provisions a Let's Encrypt certificate automatically. In Domain
management → HTTPS, confirm the certificate is issued and **Force HTTPS** is on.

### 8.5 Authorise the production domain

Firebase (`cbo-candoni-prod`) → Authentication → Settings → Authorised domains → add
`cbo.mgocandoni.com`. **Sign-in fails without this** and the error is unhelpfully generic.

Deploy:

```bash
git checkout main
git merge develop
git push
```

**Checkpoint 8.**
- `https://cbo.mgocandoni.com` loads
- `http://cbo.mgocandoni.com` redirects to HTTPS
- **No environment banner** appears
- `https://cbo.mgocandoni.com/reports/trial-balance` typed directly loads the page, not a 404
- `https://mgocandoni.com` still serves the Squarespace site, unchanged

---

## Phase 9 — First administrator and App Check

### 9.1 Grant the first Super Administrator

The named person signs in at `https://cbo.mgocandoni.com` once, so their account exists. They see
"Awaiting access". Get their UID from Firebase → Authentication → Users.

```bash
firebase use prod
firebase functions:shell
```

```js
setUserRoles({ uid: 'PASTE_UID_HERE', roles: ['SUPER_ADMIN'] })
```

They sign out and in again. All subsequent roles are granted through **Administration → Users and
Roles** — this shell step happens exactly once in the system's life.

### 9.2 Turn on App Check

Only now, with the app confirmed working:

1. Google Cloud console → **reCAPTCHA Enterprise** → create a key for `cbo.mgocandoni.com`.
2. Firebase → **App Check** → register the web app with that key.
3. Add `VITE_APPCHECK_SITE_KEY` to the Netlify production environment and redeploy.
4. Confirm the site still works.
5. **Then** set enforcement to Enforced for Firestore, Cloud Storage and Cloud Functions.

Enforcing before step 4 locks you out of your own application.

**Checkpoint 9.** The administrator can reach every module; App Check metrics show verified
requests; the site works normally with enforcement on.

---

## Phase 10 — Opening balances

> The one phase with no software shortcut. Read it before scheduling go-live.

CFMS has no bulk import for historical balances — deliberately, because importing a trial balance
from a spreadsheet without the underlying documents produces a ledger that cannot be traced, which
is exactly what the system exists to prevent. Opening balances are entered as journal entries, by
the Accountant, from the last audited figures.

### 10.1 What the Accountant needs to hand

- The trial balance as at the cutover date, per fund
- The budget position: appropriations enacted, allotments released, obligations incurred to date
- Outstanding checks and deposits in transit per bank account
- Unliquidated cash advances by accountable officer
- Outstanding payables and receivables by party

### 10.2 The order

**1. Master data first.** Offices, payees, employees, bank accounts and any accounts missing from
the seeded chart. Everything downstream references these.

**2. Budget position.** For each budget line: record the appropriation as `ORIGINAL` and approve
it; release the allotment already released; then record obligations already incurred but not yet
paid as OBRs and certify them. Do this before any opening ledger entry — the budget registry and
the ledger are independent, and the SAOB compares them.

**3. Opening journal entry, per fund.** Accounting → JEV → New → type **Manual entry**, dated the
cutover date. One line per account carrying a balance, debits and credits exactly as on the
audited trial balance, with the net difference to *Accumulated Surplus / (Deficit)* (`30101020`).
It will not save unless it balances. Post it.

**4. Subsidiary detail.** Where the opening entry touches a control account — Accounts Payable,
Advances to Officers and Employees — the balance must be split across its subsidiaries, one line
per party. A single lump sum leaves Reports → Subsidiary Ledger warning that the schedule does not
agree with the control, and the payables schedule will be unusable.

**5. Open items for reconciliation.** Record outstanding checks and deposits in transit so the
first month's bank reconciliation has something to work with. Otherwise it will not balance and
you will not know whether the cause is the opening data or a real error.

### 10.3 Verify before proceeding

| Check | Where |
|---|---|
| Trial balance matches the audited figures exactly | Reports → Trial Balance |
| Statement of Financial Position balances | Reports → Financial Statements |
| Subsidiary ledgers agree with their control accounts | Reports → Subsidiary Ledger, per control account |
| Budget registry matches the Budget Office's records | Budget → Registry |
| Cash position matches the bank reconciliation last prepared | Treasury → Cash Position |

**Checkpoint 10.** All five agree, and the Accountant confirms in writing. Then close every period
before the cutover month (Administration → Accounting Periods) so nothing can be posted into them
by accident.

---

## Phase 11 — Parallel run and cutover

Run CFMS alongside the existing manual or spreadsheet process for **one full month**. Not two weeks
— a month, so a complete cycle including month-end close and bank reconciliation is exercised.

**Week 1.** Treasury records all collections and deposits in CFMS. Budget records obligations.
Accounting records vouchers. Manual records continue in parallel.

**Week 2.** Compare daily: collections total, disbursements total, cash position. Investigate every
difference — at this stage a difference is usually a missing entry in CFMS, which is exactly what
you want to find now.

**Week 3.** Post all journal entries. Run the trial balance and compare against the manual books.

**Week 4 — month-end.** Import the bank statement, reconcile to zero, close the period, generate
the full report set, and compare every figure against the manually prepared reports.

**Cutover decision.** Go live when the month-end reports agree. If they do not, do not cut over —
find out why. A discrepancy carried into live operation compounds.

After cutover: announce the URL, brief every office, and keep the manual records for one more
month as a fallback. Then stop maintaining them — running two sets of books indefinitely is how
they diverge.

---

## Phase 12 — Ongoing operations

### Daily (automatic)

Scheduled functions already run: overdue cash advances and undeposited collections are flagged at
07:00 and 07:30 on weekdays, stale checks at 02:15, and budget balances are rebuilt from source
documents and verified at 01:30. Nothing to do — but read the notifications.

### Daily (Treasury)

Record collections, deposit intact, record the deposit. Check Dashboard → Undeposited Collections
is clear.

### Monthly close

1. All vouchers approved or returned; nothing left in review.
2. All journal entries posted.
3. Bank reconciliation for every account, finalised at zero difference.
4. Review Dashboard alerts — negative allotment balances, overdue advances.
5. Generate and file: trial balance, the five financial statements, SAOB, the registers.
6. Administration → Accounting Periods → **Close** the month.

### Backups

Set up the scheduled export once, in Cloud Scheduler:

```bash
gcloud firestore export gs://cbo-candoni-prod-backups/$(date +%Y-%m-%d) \
  --project cbo-candoni-prod
```

Daily, retained 30 days; weekly for a year; the year-end export permanently. Enable **Object
Versioning** on the Storage bucket so a replaced document can be recovered.

**Restore-test once a year, into the dev project.** A backup that has never been restored is a
hypothesis.

### Quarterly review

Administration → Users and Roles: is anyone holding a conflicting pair unnecessarily? Audit Trail
filtered to critical: how many overrides and period reopenings, and were they all justified?

---

## Rollback

| Situation | Action |
|---|---|
| Frontend broken after deploy | Netlify → Deploys → previous deploy → **Publish deploy**. Instant. |
| Cloud Function broken | `git revert <commit>` then `firebase deploy --only functions`. 5–10 min. |
| Security rules too restrictive | Revert the file and `firebase deploy --only firestore:rules`. Under a minute. |
| Bad data posted | **Never restore a backup over live data.** Reverse the journal entries. Restoring loses every transaction recorded since. |
| Total loss | Restore the latest export into a new project, redeploy, repoint Netlify. Expect several hours and the loss of everything since the last export. |

The asymmetry is deliberate: code rolls back freely, data does not. That is why corrections are
reversals.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `auth/unauthorized-domain` on sign-in | Domain not authorised in Firebase | Authentication → Settings → Authorised domains |
| Query fails, `failed-precondition` | Index still building, or missing | Firestore → Indexes; the console error carries a link that creates it |
| "Awaiting access" after granting a role | Stale ID token | Sign out and in — `setUserRoles` revokes refresh tokens, so this resolves it |
| Functions deploy fails, permissions | Cloud Build API not enabled | Accept the prompt, or enable it in the Cloud console |
| `permission-denied` writing a draft | Rules deny the status transition attempted | Correct — that transition belongs to a Cloud Function |
| Reconciliation will not finalise | Unjournalised book adjustment, or non-zero difference | Post the adjustment JEV; match remaining statement lines |
| Peso sign garbled in Excel | Opened CSV without UTF-8 | Use the Excel export instead — it carries formatting and a real currency format |
| Nightly job reports balance discrepancies | Data written outside CFMS, or a bug | Treat as a security incident: see `docs/security.md` § Incident response |

---

## Completion checklist

```
[ ]  1  Repository pushed; CI green; main protected
[ ]  2  cbo-candoni-dev created, Blaze, asia-southeast1
[ ]  3  npm run verify passes; over-allotment test refused locally
[ ]  4  Dev backend deployed; indexes enabled; seeded
[ ]  5  Staging site live with amber banner
[ ]  6  UAT signed off by Accountant, Budget Officer, Treasurer
[ ]  7  cbo-candoni-prod deployed and seeded; IAM restricted
[ ]  8  cbo.mgocandoni.com live over HTTPS; mgocandoni.com unchanged
[ ]  9  First Super Administrator granted; App Check enforced
[ ] 10  Opening balances posted and verified; prior periods closed
[ ] 11  One month parallel run; reports agree; cutover approved
[ ] 12  Backups scheduled; restore tested; monthly close documented
```
