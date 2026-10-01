# CFMS — Candoni Financial Management System

Integrated Municipal Financial Management System
**Municipal Government of Candoni, Province of Negros Occidental**

Production: **https://cbo.mgocandoni.com**

CFMS connects the Municipal Budget Office, the Municipal Accounting Office and the Municipal
Treasurer's Office in one record, from appropriation through obligation, disbursement, the General
Ledger, bank reconciliation and financial reporting.

Offices keep their own work. The Budget Office authorises; Accounting records and posts; the
Treasurer holds and moves the money and draws the checks and ADA against completed vouchers. Every
transaction carries a Journal Entry Voucher, and no journal entry reaches the General Ledger except
by the Accountant posting it.

---

## The rules this system is built on

Everything else follows from these. If you change one thing in this codebase, do not change these.

**1. The General Ledger is the only source of truth.** No financial statement balance is stored
anywhere. Every figure on a trial balance, a statement of financial position or a SAOB is computed
from posted `ledgerEntries` at the moment it is displayed. There is no screen in CFMS where a
statement balance can be typed in, and there is no cached balance that could disagree with the
ledger.

**2. Every transaction has a JEV, and the JEV is raised from the treasury report.**
A disbursement passes through two offices and three documents. Accounting approves the voucher,
which recognises what the municipality owes. The Treasurer draws the check, which moves no money in
the books on its own. At the end of the period the Treasurer batches the checks into a Report of
Checks Issued, certifies it, and forwards it; Accounting raises **one** journal entry from that
report and posts it.

```
Voucher   (Accounting)  Dr expense              Cr Due to BIR    Cr Accounts Payable
Check     (Treasury)    no entry - the check is prepared, not yet reported
RCI       (Accounting)  Dr Accounts Payable                      Cr Cash in Bank
```

Four reports work exactly this way, and share one collection, one status flow and one pair of engine
functions, because they are one document with four contents:

| Report | Covers | Journal |
|---|---|---|
| RCI | the checks drawn in the period | Check Disbursements Journal |
| RADAI | the advices sent to the bank | ADA Disbursements Journal |
| RCD | a collecting officer's receipts and deposits | Cash Receipts Journal |
| RCDisb | cash paid out, such as a cash payroll | Cash Disbursements Journal |

One journal entry per report, footing to the report total. That is what makes the Check
Disbursements Journal agree with the check register line for line — a JEV per check would produce a
journal that no longer matches the report the Accountant signed, and would bury the Accountant in
entries.

The split of authority is enforced, not merely documented. `certifyTreasuryReport` accepts only
treasury roles; `journalizeTreasuryReport` accepts only the Accountant. Treasury owns the list —
which documents are in the report. Accounting owns the entry — which accounts move, and when it
reaches the ledger. The Accountant may correct the accounts but not the amount: the entry must foot
to the total the Treasurer certified, and if the total is wrong the report goes back rather than
being quietly adjusted. A document is reported once and once only, which is what stops the same
disbursement reaching the General Ledger twice.

**3. The browser is never the authority for a balance.** The React app may display
*Available Allotment: ₱500,000*. When a user obligates ₱300,000, `certifyObligation` re-reads that
allotment from Firestore, inside the transaction that will commit the certification, and makes its
own decision. The figure the browser sent is ignored. The same holds for every control: obligations
against allotments, allotments against appropriations, debits against credits, liquidations against
cash advances, the bank against the books.

The invariants themselves live in one file, `src/lib/accounting-rules.ts`, which is vendored into
the Cloud Functions build by `scripts/sync-rules.mjs` and checked in CI. The browser and the server
run byte-identical logic; only one of them is trusted.

---

## Architecture

```
User
  └── https://cbo.mgocandoni.com          Netlify (React + Vite + TypeScript + Tailwind)
        ├── Firebase Authentication        identity; roles live in custom claims
        ├── Cloud Firestore                transactions, master data, workflow, audit
        │     └── Security Rules           the real authorisation boundary
        ├── Cloud Storage                  supporting documents, /cbo/{fy}/{fund}/{type}/{id}/
        │     └── Storage Rules            size, type and path enforcement
        ├── Cloud Functions (asia-southeast1)
        │     └── the accounting engine    every state change with financial consequence
        └── App Check                      attests requests come from the real app
```

`mgocandoni.com` stays on Squarespace and is untouched. Only the `cbo` subdomain points at Netlify.

### Where authority lives

| Layer | What it decides | What it cannot do |
|---|---|---|
| React app | what to render, what to offer | decide whether a transaction is permissible |
| Security Rules | who may read and write which document, in which state | compute a balance |
| Cloud Functions | every balance, every control, every document number | be bypassed — clients cannot write the ledger |

Nine collections deny **all** client writes and are produced only by the engine:
`ledgerEntries`, `auditLogs`, `counters`, `budgetBalances`, `budgetSummaries`, `cashPositions`,
`accountingPeriods`, `workflowHistory`, `notifications`.

---

## Getting started

```bash
git clone https://github.com/<org>/cbo-candoni.git
cd cbo-candoni
npm install
npm --prefix functions install
cp .env.example .env.local        # fill in from the Firebase console
npm run dev
```

Against the emulator suite instead of a live project:

```bash
npm run functions:build
npm run emulators                  # auth, firestore, functions, storage, UI on :4000
VITE_USE_EMULATORS=true npm run dev
npx tsx scripts/seed.ts --project cbo-candoni-dev --emulator
```

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | typecheck and production build into `dist/` |
| `npm test` | accounting invariants, money handling, dates, numbering |
| `npm run functions:build` | sync the invariants and compile the engine |
| `npm run functions:test` | verify the vendored invariants match, then run them |
| `npm run seed` | seed funds, chart of accounts, offices, tax codes, numbering |
| `npm run emulators` | Firebase emulator suite |

### First run

`scripts/seed.ts` loads the reference data: the three statutory funds, a working subset of the COA
Revised Chart of Accounts for LGUs, the municipal offices, the withholding tax codes and the
numbering rules. It deliberately creates **no users and no roles** — seeding an administrator with
a known identity into a financial system is the sort of thing that gets forgotten and later found
by somebody else.

The first Super Administrator is granted once, by hand:

```bash
firebase functions:shell --project cbo-candoni-prod
setUserRoles({ uid: '<their uid>', roles: ['SUPER_ADMIN'] })
```

Thereafter roles are granted through **Administration → Users and Roles**. A new account that signs
in with no role can see nothing at all — that is intentional, not a bug.

---

## Repository layout

```
src/
  lib/accounting-rules.ts     the invariants — canonical copy, vendored to functions
  lib/money.ts                centavos, parsing, formatting, amount in words
  lib/engine.ts               typed client for the Cloud Functions
  lib/export.ts               CSV/XLSX export, print, bank statement parsing
  types/                      the Firestore data model
  auth/                       AuthProvider and the RBAC permission table
  data/queries.ts             every Firestore query, beside its index
  components/                 UI primitives, pickers, journal grid, report shell
  pages/                      one directory per module
functions/src/
  lib/                        context (authorisation), ledger, budget, numbering, audit, period
  budget/ accounting/ treasury/ recon/ admin/
firestore.rules               the authorisation boundary
storage.rules                 document access control
firestore.indexes.json        every composite index, annotated with the query it serves
scripts/seed.ts               reference data
scripts/sync-rules.mjs        keeps the two copies of the invariants identical
docs/                         architecture, deployment, security, data model
```

## Money

Every amount is an integer number of **centavos**. ₱1,234,567.89 is stored as `123456789`. This is
not stylistic: IEEE-754 doubles cannot represent 0.1 exactly, so a trial balance built from float
pesos eventually fails to foot by a centavo and an auditor rejects it. Conversion happens only at
the edges, in `formatPeso` and `parsePeso`.

Dates are plain `YYYY-MM-DD` strings in Philippine local time, not Timestamps, so a voucher dated
30 September cannot drift into October's accounting period depending on the reader's timezone.
Audit instants *are* stored with timezone, because for those the exact moment is the point.

---

## What is built

Complete and working end to end: master data, the full budget chain (appropriation → allotment →
obligation with server-side controls and audited overrides), disbursement vouchers with withholding
tax and a proposed journal entry, the JEV engine with posting and reversal, checks and ADA,
collections → RCD → deposits, bank statement import with automatic matching and a reconciliation
that must resolve to zero, payroll, cash advances and liquidation, the reporting engine (trial
balance, five financial statements, SAOB, general and subsidiary ledgers, six journals, eight
registers, treasury reports, index of payments), document management, RBAC administration,
accounting period control and the audit trail.

Scheduled jobs verify budget balances against their source documents nightly, flag overdue cash
advances and undeposited collections each morning, and mark checks stale at six months.

Not yet built, and honestly so: inventory and PPE beyond their ledger accounts, year-end closing
automation (the reports exist; the closing-entry generator does not), GovMail/SSO sign-in, and
email notification delivery. The data model and the navigation already accommodate all of them.

## Documentation

- **[`docs/runbook-beginner.md`](docs/runbook-beginner.md) — start here if you are new to this.**
  The same twelve phases using **GitHub Desktop** instead of git commands, with every button named,
  every command explained, and what you should see after each one.
- [`docs/runbook.md`](docs/runbook.md) — the same deployment for someone comfortable with a
  terminal. Shorter, command-line throughout.
- [`docs/architecture.md`](docs/architecture.md) — how the pieces fit, and why
- [`docs/deployment.md`](docs/deployment.md) — Netlify, Firebase, the Squarespace DNS change
- [`docs/security.md`](docs/security.md) — the authorisation model and the threats it addresses
- [`docs/data-model.md`](docs/data-model.md) — collections, keys, and the transaction chain

## Licence and ownership

Property of the Municipal Government of Candoni, Province of Negros Occidental.
