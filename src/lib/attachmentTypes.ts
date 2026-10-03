import { COL } from './collections';
import type { DocumentType } from '@/types/system';
import type { TreasuryReportType } from '@/types/enums';

/**
 * What may be attached to a document, decided by the document itself.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A FREE CHOICE
 * ---------------------------------------------------------------------------
 * The attachment on a financial document is the SIGNED FORM. An Obligation
 * Request is encoded in CFMS, printed, signed by the Head of Office and the
 * Budget Officer, and the signed copy is scanned back in. That scan is an
 * Obligation Request. It is not "a supporting document", and it is certainly
 * not whichever of seven types the person uploading it happened to leave the
 * box on.
 *
 * A list that offers all seven on every screen produces exactly one outcome:
 * most attachments filed under whatever the box defaulted to. Then a year
 * later nobody can pull the signed OBRs for an audit query, because the file
 * type on them says Other.
 *
 * So the screen does not ask. The document being attached to already knows
 * the answer.
 *
 * ---------------------------------------------------------------------------
 * WHERE THERE IS GENUINELY MORE THAN ONE
 * ---------------------------------------------------------------------------
 * A Report of Collections and Deposits travels with its Abstract of
 * Collections - two forms, one report, both wanted. That is the only case with
 * a choice, and it is a choice between two right answers rather than seven.
 */
export function attachmentTypesFor(
  entityType: string,
  /** For a treasury report, which report it is. */
  variant?: TreasuryReportType | null,
): DocumentType[] {
  switch (entityType) {
    case COL.obligations:
      return ['OBR'];

    case COL.disbursementVouchers:
      return ['DV'];

    case COL.liquidations:
      return ['LIQUIDATION_REPORT'];

    case COL.treasuryReports:
      switch (variant) {
        case 'RCD':
          // Section 29 of the manual: the Abstract supports the RCD and is
          // filed with it. Both belong on this report.
          return ['RCD', 'ABSTRACT_OF_COLLECTIONS'];
        case 'RCI':
          return ['RCI'];
        case 'RADAI':
          return ['RADAI'];
        case 'RCDISB':
          return ['RCDISB'];
        default:
          return ['OTHER'];
      }

    default:
      // A screen that gains attachments without being added above still
      // works; it just has nothing better to call the file than what it is.
      // Falling back to an empty list would be worse - it would take the
      // upload away rather than label it loosely.
      return ['OTHER'];
  }
}

/**
 * Whether the supporting documents on an Obligation Request may still be
 * replaced.
 *
 * ---------------------------------------------------------------------------
 * THE LINE IS CERTIFICATION, AND IT IS LATER THAN IT WAS
 * ---------------------------------------------------------------------------
 * CFMS used to lock the attachments the moment the OBR left Draft - that is,
 * on submission. That is too early. The commonest reason to replace a scan is
 * that somebody in Budget looked at it and found it unreadable, or the wrong
 * page, and that happens AFTER it is submitted, during review. Locking at
 * submission meant the only way to fix a bad scan was to return the whole
 * obligation.
 *
 * It is too late the other way round once the Budget Officer has certified:
 * the certification says the officer saw those papers and committed the
 * municipality's allotment on them. A document that can change afterwards is
 * not evidence of anything, and the signature on the certificate would be
 * attached to a file nobody can prove was there.
 *
 * So: replaceable while the obligation is still being worked on, fixed from
 * certification onwards.
 */
const OBLIGATION_OPEN_FOR_ATTACHMENTS = new Set([
  'DRAFT',
  'SUBMITTED',
  'BUDGET_REVIEWED',
  'RETURNED',
]);

export function attachmentsLocked(status: string | undefined | null): boolean {
  if (!status) return false;
  return !OBLIGATION_OPEN_FOR_ATTACHMENTS.has(status);
}
