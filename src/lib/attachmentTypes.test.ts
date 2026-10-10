import { describe, it, expect } from 'vitest';
import {
  attachmentTypesFor,
  attachmentsLocked,
  attachmentsClosed,
  ATTACHMENT_LOCK_ROLES,
} from './attachmentTypes';
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
    expect(attachmentTypesFor(COL.treasuryReports, 'RCDISB')).toEqual(['PAYROLL', 'RCDISB']);
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

describe('attachmentsLocked', () => {
  it('lets a scan be replaced while the obligation is still being worked on', () => {
    // The commonest reason to replace one is that Budget found it unreadable
    // during review, which is after submission.
    expect(attachmentsLocked('DRAFT')).toBe(false);
    expect(attachmentsLocked('SUBMITTED')).toBe(false);
    expect(attachmentsLocked('BUDGET_REVIEWED')).toBe(false);
    expect(attachmentsLocked('RETURNED')).toBe(false);
  });

  it('fixes it once the Budget Officer has certified', () => {
    // The certification says the officer saw those papers and committed
    // allotment on them. A document that can change afterwards is not
    // evidence of anything.
    expect(attachmentsLocked('OBLIGATED')).toBe(true);
    expect(attachmentsLocked('WITH_DV')).toBe(true);
    expect(attachmentsLocked('PAID')).toBe(true);
    expect(attachmentsLocked('CLOSED')).toBe(true);
  });

  it('fixes it on a cancelled obligation too', () => {
    expect(attachmentsLocked('CANCELLED')).toBe(true);
  });

  it('treats a record with no status yet as open', () => {
    // A draft being encoded for the first time has not been saved.
    expect(attachmentsLocked(undefined)).toBe(false);
  });
});

describe('attachmentsClosed', () => {
  it('is closed once an officer has closed it by hand', () => {
    expect(attachmentsClosed({ attachmentsLockedAt: '2026-10-04T01:00:00.000Z' })).toBe(true);
  });

  it('is closed by hand even on a document that is still a draft', () => {
    // The whole point of the manual lock: the scan is known to be right
    // before the workflow would have closed it.
    expect(
      attachmentsClosed({ attachmentsLockedAt: '2026-10-04T01:00:00.000Z', status: 'DRAFT' }),
    ).toBe(true);
  });

  it('is closed by certification even with no manual lock', () => {
    expect(attachmentsClosed({ status: 'OBLIGATED' })).toBe(true);
    expect(attachmentsClosed({ attachmentsLockedAt: null, status: 'OBLIGATED' })).toBe(true);
  });

  it('is open on a draft nobody has closed', () => {
    expect(attachmentsClosed({ status: 'DRAFT' })).toBe(false);
    expect(attachmentsClosed({})).toBe(false);
    expect(attachmentsClosed({ attachmentsLockedAt: '' })).toBe(false);
  });
});

describe('the lock roles', () => {
  it('are the three signing officers and the administrator', () => {
    expect([...ATTACHMENT_LOCK_ROLES]).toEqual([
      'SUPER_ADMIN',
      'BUDGET_OFFICER',
      'MUNICIPAL_ACCOUNTANT',
      'MUNICIPAL_TREASURER',
    ]);
  });

  it('do not include the clerks who upload', () => {
    // Closing cannot be undone, so it is not a clerk's to do. They attach the
    // corrected scan; an officer closes it.
    expect(ATTACHMENT_LOCK_ROLES).not.toContain('ACCOUNTING_ENCODER');
    expect(ATTACHMENT_LOCK_ROLES).not.toContain('BUDGET_STAFF');
    expect(ATTACHMENT_LOCK_ROLES).not.toContain('TREASURY_STAFF');
  });
});

describe('a journal entry written in Accounting', () => {
  it('offers the plain supporting document', () => {
    // There is no CFMS form behind an adjusting entry - the paper is a
    // memorandum or the office's own journal voucher.
    expect(attachmentTypesFor(COL.jevs)).toEqual(['OTHER']);
  });
});
