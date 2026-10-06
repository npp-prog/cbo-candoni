import type { ECollectionReportType } from '@/types/enums';
import { kindForReportType, type ECollectionKindCode } from '@/lib/eCollections';

/**
 * The three ways money arrives without anybody handing cash over a counter.
 *
 * ---------------------------------------------------------------------------
 * WHY THREE AND NOT ONE WITH A FILTER
 * ---------------------------------------------------------------------------
 * COA Circular 2021-014 prescribes three reports, and they are three because
 * the money arrives three different ways and three different people are
 * answerable for it:
 *
 *   AR      An INTERMEDIARY collected on the municipality's behalf and issued
 *           its own Acknowledgement Receipt. Nobody in the municipality saw
 *           the money until it was remitted, so what is being certified is
 *           that the intermediary's list agrees with what reached the bank.
 *
 *   EOR     The municipality's OWN collecting officer issued an electronic
 *           Official Receipt. The officer is accountable for it in the way
 *           they are accountable for a paper receipt - except that the number
 *           came out of a system rather than a booklet.
 *
 *   DIRECT  A payor paid straight into the bank account and showed proof.
 *           Nobody issued a receipt first and no intermediary held the money,
 *           so the reference is the bank's own transaction confirmation and
 *           the report is certified by whoever keeps the cash records.
 *
 * Reporting them on one form would be certifying three different statements
 * with one sentence.
 */

/**
 * The kind itself is declared once, in `src/lib/eCollections.ts`, which the
 * engine reads the same copy of. This file adds what only a SCREEN needs -
 * what to call each one, and when to use it.
 */
export type ECollectionKind = ECollectionKindCode;

export interface ECollectionKindSpec {
  kind: ECollectionKind;
  label: string;
  /** The report this kind is gathered onto. */
  reportType: ECollectionReportType;
  /** What the receipt number column is called on the form. */
  numberLabel: string;
  numberHint: string;
  /** Annexes E and F name an intermediary; G does not. */
  withIntermediary: boolean;
  /** Annexes E and F carry a responsibility centre and a PREXC/PAP. */
  withResponsibilityCentre: boolean;
  /** One line explaining when to use it, shown on the screen. */
  when: string;
}

export const E_COLLECTION_KINDS: ECollectionKindSpec[] = [
  {
    kind: 'EOR',
    label: 'Electronic Official Receipt (eOR)',
    reportType: 'ERCD_EOR',
    numberLabel: 'eOR number',
    numberHint:
      'As issued. CFMS does not number these and neither does the intermediary - the number is typed in, and CFMS refuses one it has seen before.',
    withIntermediary: true,
    withResponsibilityCentre: true,
    when: 'Our own collecting officer issued the receipt; the money is with an intermediary until it is deposited.',
  },
  {
    kind: 'AR',
    label: "Intermediary's Acknowledgement Receipt (AR)",
    reportType: 'ERCD_AR',
    numberLabel: 'AR number',
    numberHint: "From the intermediary's own system, as it appears on their list of daily collections.",
    withIntermediary: true,
    withResponsibilityCentre: true,
    when: 'The intermediary collected and receipted it. Nobody here saw the money until it was remitted.',
  },
  {
    kind: 'DIRECT',
    label: "Paid directly into the municipality's account",
    reportType: 'ERCD_DIRECT',
    numberLabel: 'Transaction confirmation number',
    numberHint:
      "The bank's own reference, from the deposit slip, the fund transfer advice or the payor's proof of payment.",
    withIntermediary: false,
    withResponsibilityCentre: false,
    when: 'The payor paid the bank account itself and showed proof. No receipt was issued first.',
  },
];

export function eCollectionKind(kind: string): ECollectionKindSpec | null {
  return E_COLLECTION_KINDS.find((k) => k.kind === kind) ?? null;
}

/**
 * Which kind a report of this type gathers - including the RCD, which gathers
 * the ones with no kind at all and so answers `null`.
 *
 * Deliberately NOT worked out from the list above: this is the mapping the
 * engine decides with, and the two must be one thing.
 */
export function kindForReport(reportType: string): ECollectionKind | null {
  return kindForReportType(reportType) ?? null;
}

/**
 * An electronic receipt is not an accountable form.
 *
 * It matters, and it is the reason the number is typed rather than drawn from
 * the Treasury's series. A paper Official Receipt comes out of a numbered
 * booklet the Treasurer signed for; the Report of Accountability for
 * Accountable Forms accounts for every one of them, issued, cancelled or still
 * in hand.
 *
 * An eOR has no booklet. Accounting for it in the RAAF would mean the Treasurer
 * answering for serial numbers that were never issued to anybody - so an
 * e-collection consumes no accountable form, and the RAAF is right to know
 * nothing about it.
 */
export const E_RECEIPTS_ARE_NOT_ACCOUNTABLE_FORMS = true;
