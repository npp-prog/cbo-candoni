import { describe, it, expect } from 'vitest';
import { attachmentTypesFor } from './attachmentTypes';
import { COL } from './collections';
import { DOCUMENT_TYPES, DOCUMENT_TYPE_LABELS, type DocumentType } from '@/types/system';
import { TREASURY_REPORT_TYPES } from '@/types/enums';

describe('attachmentTypesFor', () => {
  it('gives an Obligation Request exactly one type: itself', () => {
    expect(attachmentTypesFor(COL.obligations)).toEqual(['OBR']);
  });

  it('gives a Disbursement Voucher exactly one type: itself', () => {
    expect(attachmentTypesFor(COL.disbursementVouchers)).toEqual(['DV']);
  });

  it('gives a Liquidation Report exactly one type: itself', () => {
    expect(attachmentTypesFor(COL.liquidations)).toEqual(['LIQUIDATION_REPORT']);
  });

  it('gives a Report of Collections and Deposits its Abstract as well', () => {
    // The only screen with a choice, and it is a choice between two right
    // answers: the RCD and the Abstract that is filed with it.
    expect(attachmentTypesFor(COL.treasuryReports, 'RCD')).toEqual([
      'RCD',
      'ABSTRACT_OF_COLLECTIONS',
    ]);
  });

  it('gives every other treasury report exactly its own form', () => {
    expect(attachmentTypesFor(COL.treasuryReports, 'RCI')).toEqual(['RCI']);
    expect(attachmentTypesFor(COL.treasuryReports, 'RADAI')).toEqual(['RADAI']);
    expect(attachmentTypesFor(COL.treasuryReports, 'RCDISB')).toEqual(['RCDISB']);
  });

  it('covers every treasury report type there is', () => {
    // If a report type is ever added, this fails rather than quietly filing
    // that report's attachments as "Other".
    for (const t of TREASURY_REPORT_TYPES) {
      expect(attachmentTypesFor(COL.treasuryReports, t)).not.toEqual(['OTHER']);
    }
  });

  it('never offers a free-for-all list', () => {
    const everywhere = [
      attachmentTypesFor(COL.obligations),
      attachmentTypesFor(COL.disbursementVouchers),
      attachmentTypesFor(COL.liquidations),
      ...TREASURY_REPORT_TYPES.map((t) => attachmentTypesFor(COL.treasuryReports, t)),
    ];

    for (const list of everywhere) {
      expect(list.length).toBeLessThanOrEqual(2);
      expect(list).not.toContain('OTHER');
    }
  });

  it('falls back to a named type rather than nothing on an unknown screen', () => {
    // An empty list would take the upload away altogether, which is worse
    // than labelling it loosely.
    expect(attachmentTypesFor('somethingNew')).toEqual(['OTHER']);
    expect(attachmentTypesFor(COL.treasuryReports, null)).toEqual(['OTHER']);
  });

  it('only ever returns types that exist and have a label', () => {
    const produced = new Set<DocumentType>([
      ...attachmentTypesFor(COL.obligations),
      ...attachmentTypesFor(COL.disbursementVouchers),
      ...attachmentTypesFor(COL.liquidations),
      ...TREASURY_REPORT_TYPES.flatMap((t) => attachmentTypesFor(COL.treasuryReports, t)),
    ]);

    for (const t of produced) {
      expect(DOCUMENT_TYPES).toContain(t);
      expect(DOCUMENT_TYPE_LABELS[t]).toBeTruthy();
    }
  });
});
