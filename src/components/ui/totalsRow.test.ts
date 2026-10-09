import { describe, it, expect } from 'vitest';
import { totalsLayout } from './totalsRow';

/** Patch 122: the totals row follows the columns on screen. */
describe('totalsLayout', () => {
  const voucherColumns = [
    'dvNo',
    'dvDate',
    'kind',
    'payee',
    'particulars',
    'net',
    'payment',
    'status',
  ];

  it('puts the total under its own column - the voucher list as Neil saw it', () => {
    const l = totalsLayout(voucherColumns, ['net']);
    expect(l.labelSpan).toBe(5);
    expect(l.cells).toEqual(['net', 'payment', 'status']);
  });

  it('moves with a column shown in Columns', () => {
    const withObr = [
      'dvNo',
      'dvDate',
      'kind',
      'obrNo',
      'payee',
      'particulars',
      'gross',
      'net',
      'payment',
      'status',
    ];
    const l = totalsLayout(withObr, ['gross', 'net']);
    expect(l.labelSpan).toBe(6);
    expect(l.cells[0]).toBe('gross');
  });

  it('spans the whole row when every total column is hidden', () => {
    expect(totalsLayout(['a', 'b', 'c'], ['x'])).toEqual({ labelSpan: 3, cells: [] });
  });

  it('gives no label room when the first column holds a total', () => {
    expect(totalsLayout(['amount', 'status'], ['amount'])).toEqual({
      labelSpan: 0,
      cells: ['amount', 'status'],
    });
  });
});
