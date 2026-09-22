# Security and internal control

Municipal Government of Candoni — CBO

This document describes what protects the municipality's financial records, and — as importantly —
what does not.

---

## The threat this system is actually designed against

Not an anonymous attacker on the internet. The realistic threats to a municipal accounting system,
in order of likelihood:

1. **An honest mistake that nobody catches** — a voucher paid twice, an obligation exceeding its
   allotment, a collection never deposited, a reconciliation that balances because someone typed
   the book balance in by hand.
2. **A legitimate user exceeding their authority** — an encoder approving their own voucher, a
   clerk posting into a closed month to make a report come out right.
3. **After-the-fact alteration** — editing a posted entry, deleting an audit record, quietly
   swapping a supporting document.
4. **An outsider with valid credentials** — a shared password, an unlocked workstation.

Most of the design below addresses the first three. They are the ones that actually cost
municipalities money and produce audit findings.

---

## Four layers of authorisation

### 1. Authentication — who you are

Firebase Authentication, email and password, session-scoped persistence (closing the browser ends
the session) plus a 45-minute idle timeout. A finance workstation left unlocked in a municipal
hall is a real risk.

A new account arrives with **no roles at all** and can see nothing. This is deliberate: a Firebase
account by itself must never be a foothold in the municipality's financial records.

### 2. Firestore Security Rules — what you may touch

This is the real authorisation boundary. Anyone holding a valid login can open a browser console
and call the Firestore SDK directly, so `firestore.rules` assumes the client is hostile.

Roles are read from **Firebase Auth custom claims**, not from the user's document. The claim is
signed by Firebase and cannot be forged. The `users` document is a readable mirror for the
administration screen, and the rules explicitly forbid a user writing their own `roles` field — so
there is no path by which a user promotes themselves.

Three tiers:

**Server only.** Nine collections deny every client write:

```
ledgerEntries       the General Ledger
auditLogs           the audit trail
counters            document number sequences
budgetBalances      the control balances
budgetSummaries     dashboard rollups
cashPositions       derived cash figures
accountingPeriods   period open/closed state
workflowHistory     approval history
notifications       (read and mark-read only)
```

The Admin SDK bypasses rules, which is precisely why these can be written by Cloud Functions and
by nothing else. The invariant *"a ledger entry exists if and only if a JEV was posted through
`postJevInTransaction`"* holds by construction rather than by convention.

**Engine-only transitions.** A client may create and edit a document in `DRAFT`, and submit it.
Everything beyond that — `CERTIFIED`, `APPROVED`, `POSTED`, `PAID` — is refused by the rules and
comes only from a callable. The single most important line in the file is the one that makes a
posted JEV immutable: without it, a posted entry could be edited after the fact and the General
Ledger would no longer be evidence of anything.

**Client-writable.** Drafts, master data, document metadata, and a user's own display name.

### 3. Cloud Functions — whether it is permissible

Every function begins with `requireCaller(request, [...roles])`. There is no default-allow path;
because these run with Admin credentials, a callable that forgets this line has no protection at
all. A reviewer should treat its absence as a defect.

Each function then re-reads every balance it needs *inside the transaction that will commit*, and
decides. Nothing sent by the browser is used in a control decision.

### 4. App Check — that the request came from the real app

reCAPTCHA Enterprise attestation, enforced on Firestore, Storage and Functions. Not a substitute
for rules — an additional gate in front of them, which raises the cost of scripting against a
copied web config.

---

## The controls themselves

| Control | Where enforced | Behaviour |
|---|---|---|
| Debits = credits | `checkDoubleEntry`, re-run at posting | Posting refused |
| Obligation ≤ available allotment | `certifyObligation`, transactional read | Refused, or overridden with a recorded reason |
| Allotment ≤ revised appropriation | `releaseAllotment` | Refused |
| Voucher ≤ unpaid obligation balance | `approveDv` | Refused |
| Liquidation ≤ cash advance | `postLiquidation` | Refused unless the excess is a reimbursement claim |
| Bank reconciliation = 0 | `finalizeReconciliation` | Refused at any non-zero difference |
| Closed period | every posting function | Refused |
| Unique check number per bank account | `issueCheck` via document id | Refused by the database, not by a check |
| Unique document numbers | `counters` inside the transaction | Concurrent submissions get consecutive numbers |
| Duplicate payment | `findProbableDuplicates` | Warned, not blocked |
| Four-eyes on approval | `assertNotSelfApproval` | Refused unless an administrator relaxes it |
| Collection reported once | `postRcd` | Refused if already in another RCD |
| Book adjustments journalised | `finalizeReconciliation` | Refused if any is unposted |

### Overrides are visible, not hidden

Budget override is permitted — a municipality occasionally needs it — but it requires a written
reason of at least twenty characters, is written onto the face of the OBR, is logged as a
`CRITICAL` audit event, notifies the Municipal Accountant, and appears on the registry thereafter.
An administrator can turn the override off entirely in Settings, making the budget control
absolute.

Reopening a closed accounting period works the same way: fifteen characters of reason minimum, a
critical audit event, a notification, and a permanent reopening count displayed on the periods
screen. It should never become routine, and the record makes it obvious if it has.

### Corrections are reversals, never edits

A posted journal entry cannot be edited or deleted by anyone, including a Super Administrator. The
only correction is a reversing entry — a mirror image, posted today so a closed month stays
closed, with each entry pointing at the other. Both stay in the ledger forever.

This is not ceremony. A deleted entry leaves the books balanced and the history false. A reversal
leaves both the error and its correction visible, which is what an auditor needs in order to
conclude the error was handled honestly.

---

## Segregation of duties

Ten roles, each with a permission set. The system warns — and records a `CRITICAL` audit event —
when a user holds a conflicting pair:

| Pair | What one person could do alone |
|---|---|
| Encoder + Accountant | Encode and post to the General Ledger |
| Budget Staff + Budget Officer | Prepare and certify an obligation |
| Treasury Staff + Treasurer | Record and approve collections |
| Reviewer + Encoder | Review a voucher they encoded |
| Auditor + Accountant | Audit and transact |

It warns rather than blocks because a four-person accounting office sometimes has no alternative.
What matters is that the combination is a deliberate, recorded decision rather than something that
accumulated unnoticed over three years.

The COA/Auditor role is read-only across the entire system, including supporting documents and the
audit trail, and is deliberately granted export and print. An auditor who cannot take a working
copy will ask for a database dump instead, which is worse for everybody.

---

## The audit trail

Append-only. Rules deny client create, update and delete. Each record is written **inside the same
Firestore transaction** as the change it describes — an audit entry written afterwards can be lost
if the process dies in between, leaving a financial change with no record of who made it.

Each record carries the actor, their roles at that moment, the timestamp, the IP address where
available, the document, and field-level before/after values for edits. Events are graded, and
these are always `CRITICAL`: permission changes, period reopenings, budget overrides, journal
reversals and settings changes.

Document attachments are never overwritten. Storage rules refuse `update` on an existing object
entirely; a replacement is a new version, and the previous metadata record is marked superseded
while the bytes remain. Evidence that can be silently swapped is not evidence.

---

## Documents

Path: `/cbo/{fiscalYear}/{fund}/{documentType}/{documentId}/{file}`

Storage rules enforce, independently of the UI: authenticated and active users only, 25 MB per
file, a fixed content-type allow-list (PDF, JPEG, PNG, XLSX, DOCX), writes only under `/cbo/`, no
overwrites, and deletes for administrators alone. Files open through a signed URL obtained at
click time, so access is re-checked on every open rather than resting on a permanent public link.

---

## Nightly verification

`budgetBalances` is a transactionally maintained cache, so in principle it cannot drift. A
scheduled function rebuilds every balance from its source appropriations, allotments and
obligations each night and compares. A discrepancy means the budget control has been operating on
a wrong number — it raises a `CRITICAL` audit event and notifies the administrators, because that
is worth waking someone for.

Similarly, `trialBalance()` throws if the ledger fails to foot, with a message that says plainly
what it means: ledger entries can only be written by the posting function, so a difference
indicates data was altered outside CBO. That is a security incident, not a rounding problem, and
the message says so rather than offering to adjust.

---

## What this design does not protect against

Stated plainly, because a security document that claims completeness is not useful.

- **A compromised Super Administrator account.** That role can grant roles, reopen periods and
  change control settings. Every action is logged and unalterable, so the damage is *visible* —
  but it is not prevented. Keep the number of administrators small, review the critical audit log
  regularly, and enrol MFA when it is configured.
- **Someone with Firebase console access.** A project owner can edit Firestore directly, bypassing
  every rule and every function. The nightly verification job and the trial-balance check are
  designed to make that detectable, not impossible. Restrict IAM on the production project to as
  few people as the municipality can manage.
- **Collusion between an encoder and an approver.** Segregation of duties raises the number of
  people who must agree; it cannot reduce it below two.
- **Bad data entered in good faith.** CBO checks arithmetic, controls and consistency. It cannot
  know that an invoice is fictitious.
- **Shared passwords.** The audit trail records the account, not the person at the keyboard.

---

## Incident response

If the trial balance fails to foot, or the nightly verification reports discrepancies:

1. **Stop posting.** Lock the affected periods (Administration → Accounting Periods).
2. Export the audit trail filtered to that fund and period range.
3. Compare `ledgerEntries` against the source documents — the ledger carries `sourceType` and
   `sourceId` on every row, so each entry traces back to the voucher or report that produced it.
4. Check Firebase console access logs for direct database writes.
5. Correct through reversing entries, never by editing. The correction must be as visible as the
   error.
