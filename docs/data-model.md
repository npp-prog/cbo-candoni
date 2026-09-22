# Data model

Municipal Government of Candoni — CBO

Every collection, who may write it, and how the chain links together. Types are defined in
`src/types/`; collection names are constants in `src/lib/collections.ts` and are referenced by
`firestore.rules`.

---

## Conventions

- **Amounts** are integers in centavos. `₱1,234,567.89` → `123456789`.
- **Dates** are `YYYY-MM-DD` strings in Philippine local time. **Instants** are ISO strings with
  timezone.
- **Denormalised labels** (`accountName`, `payeeName`, `officeName`) are copied onto every
  transaction so a posted document prints as it was approved. The master record remains the
  authority for classification.
- **Nothing financial is deleted.** Documents are cancelled; master data is deactivated.
- **W** in the tables below: `C` = client may write (subject to rules), `S` = server only.

---

## Master data

| Collection | Id | W | Notes |
|---|---|---|---|
| `funds` | fund code | C | `GF`, `SEF`, `TF`. `bookCode` feeds document numbers. Each fund keeps a complete, independent set of books. |
| `accounts` | account code | C | COA Revised Chart for LGUs. `fsClassification` decides where it lands on the statements; `cashFlowClass` feeds the cash flow statement. Accountant and admin only. |
| `offices` | office code | C | Departments. |
| `responsibilityCenters` | auto | C | UACS responsibility centres under an office. |
| `programs` / `projects` / `activities` | auto | C | The PPA structure budget lines charge against. |
| `payees` | auto | C | Suppliers, contractors, employees, barangays, agencies. Encoders may add one mid-voucher — blocking that guarantees duplicate payees under vague names. |
| `employees` | auto | C | Payroll, cash advances, collecting officers. |
| `banks` / `bankAccounts` | auto | C | A bank account belongs to exactly one fund. |
| `taxCodes` | code | C | Rate plus the base it applies to — gross, or net of VAT. |
| `fiscalYears` | year | S | Open / closing / closed. |
| `numberingRules` | doc type | C | Admin only. |

---

## Budget

### The budget key

Appropriations, allotments and obligations all carry the same seven dimensions:

```
fiscalYear · fundCode · officeId · responsibilityCenterId · programId · projectId · activityId · accountCode
```

`budgetKeyId()` flattens them into a deterministic string, used as the id of the running balance
document. That is what makes the control work: two simultaneous obligations against the same line
contend on one document, and Firestore aborts and retries the second.

| Collection | Id | W | Notes |
|---|---|---|---|
| `appropriations` | auto | C (draft) | `kind`: ORIGINAL, SUPPLEMENTAL, CONTINUING, REALIGNMENT, TRANSFER, ADJUSTMENT. Realignments come in signed pairs. Approval is server-side. |
| `allotments` | auto | C (draft) | Signed: positive is a release, negative a withdrawal. Release is server-side. |
| `obligations` | auto | C (draft) | Multi-line. Carries `disbursedAmount` and `unpaidAmount`, maintained only by the engine. An `override` object records any certification beyond the available allotment. |
| `budgetBalances` | `budgetKeyId` | **S** | The running control balance. Rebuildable; verified nightly. |
| `budgetSummaries` | `{year}__{fund}` | **S** | Dashboard rollup. Display only — never used for a control decision. |

`budgetBalances` holds the four appropriation components, the revised total, allotments released,
available appropriation, obligations, available allotment, disbursements and unpaid obligations.
The three derived figures are recomputed from the components on every write.

---

## Accounting

| Collection | Id | W | Notes |
|---|---|---|---|
| `disbursementVouchers` | auto | C (draft) | Multiple account lines, multiple deductions. `gross − deductions = net`, re-verified server-side. Links to its obligation, its JEV and its check or ADA. |
| `jevs` | auto | C (manual only) | Manual, adjusting, closing and prior-period entries may be drafted in the client; those generated from a DV, RCD or payroll are created by the engine. A `POSTED` JEV is immutable — rules refuse the update. |
| `ledgerEntries` | auto | **S** | **The General Ledger.** One immutable document per posted line. Never updated, never deleted. |
| `checks` | `{bankAccountId}__{checkNo}` | **S** (create) | The composite id makes uniqueness a database constraint. Clients may record release details only. |
| `ada` | auto | **S** (create) | Clients may record bank submission details only. |
| `payrolls` | auto | C (draft) | Lines per employee with each statutory deduction. |
| `cashAdvances` | auto | **S** | Created when a cash-advance voucher posts, so the outstanding balance cannot begin life out of step with the ledger. |
| `liquidations` | auto | C (draft) | Settles an advance. Posting is server-side. |
| `accountingPeriods` | `{year}_{period}_{fund}` | **S** | OPEN / TEMPORARILY_LOCKED / CLOSED / REOPENED, with the reopening count. |

### A ledger entry

```ts
{
  fiscalYear, period, fundCode, entryDate,
  jevId, jevNo, jevLineNo, book,
  accountCode, accountName,
  signedAmount,          // debit positive — a trial balance is one sum
  debit, credit,
  officeId, responsibilityCenterId,
  subsidiaryType, subsidiaryId, subsidiaryName,
  cashFlowClass,
  sourceType, sourceId, referenceNo, payeeId, payeeName, particulars,
  postedAt, postedByUid, isReversal
}
```

`sourceType` and `sourceId` are what make the audit trail walkable: a figure on a statement → the
ledger → the JEV → the voucher → the scanned invoice.

---

## Treasury and reconciliation

| Collection | Id | W | Notes |
|---|---|---|---|
| `collections` | auto | C | One official receipt with its revenue distribution. Immutable once issued except for non-monetary corrections — an OR in a citizen's hands is not editable. |
| `rcds` | auto | C (draft) | Gathers a collecting officer's receipts. Posting verifies each receipt exists, belongs to this fund, and is not already in another RCD. |
| `deposits` | auto | C | `RECORDED → IN_TRANSIT → CREDITED`. In transit until reconciliation matches the bank credit — which is what makes deposits-in-transit a derived figure rather than a manual adjustment. |
| `accountableForms` | auto | C | Quantities in pieces, not centavos. The one place in CBO where an amount is not money. |
| `bankTransactions` | auto | **S** (create) | Imported statement lines, each with a content fingerprint so a re-import is detected. Clients may confirm or reject a proposed match. |
| `bankReconciliations` | auto | C (draft) | Finalisation is server-side: the book balance is re-read from the ledger and the difference must be zero. |
| `importBatches` | auto | **S** | Import provenance. |
| `cashPositions` | `{year}__{bankAccountId}` | **S** | Updated at finalisation. |

---

## System

| Collection | Id | W | Notes |
|---|---|---|---|
| `users` | uid | C (own display fields only) | A mirror of the Auth custom claims. Rules forbid writing `roles` — the claims, not this document, are what security rules read. |
| `roleDefinitions` | role | C (admin) | Permission overrides for the built-in roles. |
| `workflowHistory` | auto | **S** | One event per transition: actor, previous and new status, remarks, role it now sits with. |
| `auditLogs` | auto | **S** | Append-only. Written inside the same transaction as the change. |
| `documents` | auto | C (create) | Attachment metadata; bytes in Cloud Storage. Superseded, never overwritten. |
| `notifications` | auto | **S** (create) | Addressed to a user or to a role. Clients may mark their own as read. |
| `settings` | `general` | C (admin) | Identity, control switches, signatories. |
| `counters` | see below | **S** | Not even readable by clients. |

### Counters

```
{docType}__{fund}__{year}__{month}     resetOn: MONTH
{docType}__{fund}__{year}              resetOn: YEAR
{docType}__{fund}                      resetOn: NEVER
```

Read and incremented inside the transaction that commits the document. Two users submitting in the
same second receive consecutive numbers, and a discarded draft never consumes one.

---

## Storage

```
/cbo/{fiscalYear}/{fund}/{documentType}/{documentId}/{timestamp}_{fileName}
```

e.g. `/cbo/2026/GF/DV/100-26-09-0001/1726900000000_invoice-scan.pdf`

The timestamp prefix means a re-upload of the same file name never collides with the original —
which Storage rules forbid overwriting.

```
/system/{fileName}              seal and letterhead, admin only
/archives/{fiscalYear}/{file}   year-end exports, server-written
```

---

## Indexes

Every composite query in `src/data/queries.ts` has a matching entry in `firestore.indexes.json`,
annotated with the query it serves. Keeping them together means a query added without its index is
caught in review rather than at runtime, where it surfaces as a `failed-precondition` error in
front of a user.

`fieldOverrides` excludes fields never queried — `particulars` on `ledgerEntries`, the line arrays
on vouchers and JEVs, the `changes` array on audit logs. On the highest-volume collection in the
system, not indexing what nobody filters on is a real saving on every write.
