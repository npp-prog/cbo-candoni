import { describe, it, expect } from 'vitest';
import { buildBankCredits } from './bankCreditRows';

/** Patch 144: the RADAI's Bank Credits sub-tab. */
describe('bank credits', () => {
  const group = {
    id: 'a2',
    adaNo: '2026-10-0002',
    adaDate: '2026-10-09',
    status: 'SUBMITTED',
    payeeName: 'Ana, et al.',
    amount: 1000,
    treasuryReportNo: '2026-101',
    dateSubmittedToBank: '2026-10-10',
    payees: [
      { lineNo: 1, payeeName: 'Ana', accountNumber: '0011223344', amount: 600 },
      { lineNo: 2, payeeName: 'Ben', accountNumber: '5566778899', amount: 400 },
    ],
    notPosted: [{ lineNo: 2, payeeName: 'Ben', accountNumber: '5566778899', amount: 400 }],
    notPostedJevId: 'j1',
  };

  it('lists each payee of a group advice, posted or not', () => {
    const rows = buildBankCredits([group], () => '');
    expect(rows.map((r) => [r.payeeName, r.status, r.notPostedJevId])).toEqual([
      ['Ana', 'POSTED', null],
      ['Ben', 'NOT_POSTED', 'j1'],
    ]);
  });

  it('shows a prepared advice as awaiting, with the payee record account, and leaves out a cancelled one', () => {
    const rows = buildBankCredits(
      [
        { id: 'a1', adaNo: '1', adaDate: '2026-10-09', status: 'PREPARED', payeeId: 'p1', payeeName: 'Cy', amount: 5 },
        { id: 'a3', adaNo: '3', adaDate: '2026-10-09', status: 'CANCELLED', payeeName: 'Di', amount: 5 },
      ],
      (id) => (id === 'p1' ? '1234567890' : ''),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'AWAITING', accountNumber: '1234567890' });
  });
});
