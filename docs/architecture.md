# Architecture

Municipal Government of Candoni — CFMS

Why the system is shaped the way it is. The deployment mechanics are in
[`deployment.md`](deployment.md); the authorisation model is in [`security.md`](security.md).

---

## The accounting spine

```
  Appropriation          enacted by ordinance; no upstream control
        │                 recorded with its authority reference
        ▼
  Allotment              CONTROL: cumulative allotments ≤ revised appropriation
        │
        ▼
  Obligation (OBR)       CONTROL: obligation ≤ available allotment
        │                 assigns the OBR number; commits the allotment
        ▼
  Disbursement Voucher   CONTROL: voucher ≤ unpaid obligation balance
        │                 gross − deductions = net; entry must balance
        ▼
  Journal Entry Voucher  CONTROL: debits = credits; period open
        │                 posting is a separate act by a separate role
        ▼
  Ledger entries         immutable; the only source of truth
        │
        ├──► Check / ADA ──► Bank transaction ──► Bank reconciliation
        │                                          CONTROL: difference = 0
        └──► Trial balance ──► Financial statements, SAOB, registers
```

Revenue mirrors it:

```
  Collection (OR) ──► RCD ──► Deposit ──► Ledger entries ──► Bank credit ──► Reconciliation
                      │         │
              CONTROL: each     in transit until matched
              receipt reported
              exactly once
```

Each arrow is a Cloud Function. Each CONTROL is checked server-side, inside the transaction that
commits, against balances read at that moment.

---

## Why Firestore, and what that costs

The specification names Firestore, and the shape of this system suits it: documents are naturally
document-shaped (a voucher with its lines and deductions is one document, read and written
atomically), the read patterns are known in advance, and real-time listeners mean a status change
appears on every screen showing it without a refresh — which matters when an encoder, a reviewer
and the Accountant are working the same queue.

What it costs, and how each cost is paid:

**No joins.** Every transaction denormalises what it needs to display: account code and name,
payee name, office name. The master record stays the authority for *classification*; the copy
exists so a posted document prints exactly as it was approved, even if the master is later
renamed. Master data is therefore never deleted, only deactivated.

**No aggregate queries.** A trial balance cannot be `SELECT SUM(...) GROUP BY`. Reports read a
period's worth of ledger entries and aggregate in the browser — appropriate for the volumes a
municipality of Candoni's size produces, and every such query is scoped by fund, year and period
so the whole ledger is never pulled.

**No unique constraints.** Uniqueness is bought with document ids. A check's id is
`{bankAccountId}__{checkNo}`, so `tx.create` throws if the number already exists on that account —
a database constraint, not an application check with a race between read and write.

**No transactions across a query.** Firestore transactions require all reads before any write, and
cannot read a query result transactionally. This shapes the control design: the running balance
per budget line lives in one document, `budgetBalances/{budgetKeyId}`, whose id is derived from the
budget key. Two simultaneous obligations against the same line contend on that single document,
and Firestore aborts and retries the second — which is exactly the serialisation the control needs.

**Derived state must be verifiable.** `budgetBalances` is a cache. It is maintained
transactionally so in principle it cannot drift, and a nightly job rebuilds every balance from its
source documents and raises a critical alert on any discrepancy. The source documents remain the
record.

---

## The vendored invariants

`src/lib/accounting-rules.ts` holds every accounting invariant as pure functions with no I/O:
double entry, the budget controls, voucher arithmetic, liquidation, reconciliation, period control,
duplicate detection, trial balance.

The frontend uses them to give a user immediate feedback while they type — the running
out-of-balance figure on the journal grid, the available-allotment column on the OBR form. The
Cloud Functions use the *same code* to make the real decision against server-read balances.

They cannot share a module: Firebase deploys only the `functions` directory, so a relative import
into `../src` builds locally and fails in the cloud. So `scripts/sync-rules.mjs` copies the file to
`functions/src/lib/rules.ts` on every functions build, and `--check` fails CI if they have
diverged. Duplication with an enforced equality check is the least bad option, and it keeps the
invariants testable in both runtimes.

The result: the browser and the server never disagree, while only one of them is trusted.

---

## Money and dates

**Centavos.** Every amount is an integer. `₱1,234,567.89` is `123456789`. IEEE-754 doubles cannot
represent 0.1 exactly; a trial balance built from float pesos eventually fails to foot by a
centavo, and an auditor rejects it. Conversion happens only at the edges.

Where a single amount must be split across several lines — a voucher drawing partially on a
multi-line obligation, for instance — the last line absorbs the rounding remainder, so the parts
sum exactly to the whole rather than being a centavo out.

**Plain date strings.** `YYYY-MM-DD`, Philippine local. A voucher dated 30 September belongs to
September's accounting period regardless of where the browser is. A `Timestamp` created in a
UTC-5 browser on the evening of the 30th lands on 1 October and silently moves the transaction
into the next period. Audit instants *are* stored with timezone, because there the exact moment is
the point.

---

## The reporting engine

There is no reporting database, no materialised statement balances, no nightly rollup that could
disagree with the ledger. Every report is a function of posted `ledgerEntries`:

| Report | Derivation |
|---|---|
| Trial balance | Sum debits and credits per account, up to a period |
| Financial Position | Group by each account's FS classification; credit-normal classes negated for presentation |
| Financial Performance | Revenue less expenses |
| Cash Flows | Cash-account movements grouped by cash-flow classification |
| General Ledger | One account, date order, running balance from signed amounts |
| Subsidiary Ledger | One control account, split by subsidiary, with an agreement check against the control |
| Journals | Filtered by `book`, which posting assigns from the source document type |
| SAOB | From `budgetBalances`, with actual expenditure taken independently from the ledger |
| Payables / receivables schedules | Subsidiary detail of the control accounts, aged |

The sign convention is the one thing to get right: ledger entries store a signed amount where a
debit is positive, so a trial balance is a single sum. Credit-normal classes are negated for
presentation. Getting this backwards produces a statement that foots perfectly and reads as
nonsense.

The Statement of Comparison of Budget and Actual Amounts is deliberately built from *two*
independent sources — budget figures from `budgetBalances`, actual expenditure from the ledger —
because the whole point of that statement is to compare them.

---

## Printing

Reports print through the browser's own dialogue under the `@media print` rules in `index.css`,
rather than a bundled PDF library. That is a trade: a client-side generator gives byte-exact
output, at the cost of several hundred kilobytes of bundle, a second layout engine to maintain,
and embedded fonts for the peso sign. The browser already paginates correctly, repeats the
official heading on every page via `display: table-header-group`, and "Save as PDF" exists in every
print dialogue on every platform the municipality uses. Where a signed archival PDF is genuinely
needed at year end, that belongs in a Cloud Function.

---

## Designed for the MGO Portal

CFMS is one application in a planned municipal ecosystem — `pms`, `ims`, `abo`, eventually
`portal.mgocandoni.com`. Three decisions keep that path open:

**Identity is already shared.** Roles live in Firebase Auth custom claims, not in CFMS's database.
Another application in the same Firebase project reads the same claims. A portal issuing a single
session across applications needs no change here.

**The domain pattern is uniform.** Each system is its own Netlify site behind its own CNAME on
`mgocandoni.com`. The root domain and the Squarespace site are never touched. Adding `portal`
later is one more record.

**The engine is a callable API.** The Cloud Functions are not coupled to this React app; they take
document ids and return results. A portal shell, a mobile client or another municipal system can
call `certifyObligation` with the same guarantees, because the authorisation and the controls live
in the function rather than in the caller.
