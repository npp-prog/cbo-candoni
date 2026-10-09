import { describe, expect, it } from 'vitest';
import { renumberedDraft } from './reportNumber';

const entry = [
  { accountCode: '20101010', debit: 120_000, credit: 0, particulars: 'Payment of Check No. 1234' },
  {
    accountCode: '10102010',
    debit: 0,
    credit: 120_000,
    particulars: 'Payment of RCI 2026-10-05 Check No. 1234 - Supplies',
  },
];

describe('renumberedDraft (patch 149)', () => {
  it('changes the number and the RCI cash lines that quote it', () => {
    const out = renumberedDraft({ reportType: 'RCI', entry }, ' 2026-10-0005 ');
    expect(out.reportNo).toBe('2026-10-0005');
    expect(out.entry?.[1].particulars).toBe(
      'Payment of RCI 2026-10-0005 Check No. 1234 - Supplies',
    );
    expect(out.entry?.[0]).toEqual(entry[0]);
  });

  it('changes only the number of a RADAI, whose entry does not quote it', () => {
    expect(renumberedDraft({ reportType: 'RADAI', entry }, '2026-102')).toEqual({
      reportNo: '2026-102',
    });
  });

  it('changes only the number when there is no entry', () => {
    expect(renumberedDraft({ reportType: 'RCI', entry: [] }, '7')).toEqual({ reportNo: '7' });
  });
});
