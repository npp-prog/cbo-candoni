import { describe, expect, it } from 'vitest';
import { buildCashFlows, type CashFlowEntry } from './cashFlows';
import { captionFor, isCashAccount } from '@/lib/cashFlowLines';

/**
 * Tests for the Statement of Cash Flows.
 *
 * The one that matters most is the tie-out: opening cash plus every flow the
 * statement reports must equal the cash balance in the General Ledger. It is
 * asserted on every scenario below, not only in the test that is about it,
 * because a caption mapping that quietly drops a line would still leave every
 * individual caption looking plausible.
 */

let seq = 0;
/** One journal entry: pairs of [accountCode, signedAmount]. */
function jev(
  lines: Array<[string, number, string?]>,
  opts: { period?: number; sourceType?: string; jevNo?: string } = {},
): CashFlowEntry[] {
  seq += 1;
  const jevId = `jev${seq}`;
  const jevNo = opts.jevNo ?? `JEV-${seq}`;
  return lines.map(([accountCode, signedAmount, accountName]) => ({
    jevId,
    jevNo,
    period: opts.period ?? 1,
    accountCode,
    accountName: accountName ?? accountCode,
    signedAmount,
    sourceType: opts.sourceType,
  }));
}

const build = (entries: CashFlowEntry[], priorClosingCash = 0) =>
  buildCashFlows({ entries, throughPeriod: 12, priorClosingCash });

const find = (s: ReturnType<typeof build>, caption: string) => {
  for (const b of s.blocks) {
    const row = [...b.inflows, ...b.outflows].find((r) => r.caption === caption);
    if (row) return row;
  }
  throw new Error(`no caption ${caption}`);
};

describe('isCashAccount', () => {
  it('takes major group 1-01 as cash', () => {
    expect(isCashAccount('10101010')).toBe(true); // Cash Local Treasury
    expect(isCashAccount('10102010')).toBe(true); // Cash in Bank, Current Account
  });

  it('does not take the time deposits in group 1-02 as cash', () => {
    // Their titles begin "Cash in Bank" but the chart files them under
    // Investments, and the statement follows the chart.
    expect(isCashAccount('10201010')).toBe(false);
  });
});

describe('captionFor', () => {
  it('sends the same asset account to opposite captions by direction', () => {
    expect(captionFor('10701010', 'OUT').caption).toBe(
      'Purchase/Construction of Property, Plant and Equipment',
    );
    expect(captionFor('10701010', 'IN').caption).toBe(
      'Proceeds from Sale/Disposal of Property, Plant and Equipment',
    );
  });

  it('puts loans receivable under investing though the account class is operating', () => {
    // The classifier calls major group 1-03 operating, which is right for
    // trade receivables; the annex puts lending under investing, and the annex
    // decides where a line prints.
    const out = captionFor('10301050', 'OUT');
    expect(out.caption).toBe('Grant of Loans');
    expect(out.section).toBe('INVESTING');

    const trade = captionFor('10301010', 'IN');
    expect(trade.section).toBe('OPERATING');
  });

  it('separates the internal revenue allotment from the other tax revenue', () => {
    expect(captionFor('40106010', 'IN').caption).toBe('Share from Internal Revenue Allotment');
    expect(captionFor('40101010', 'IN').caption).toBe('Collection from taxpayers');
  });

  it('prefers the longer prefix', () => {
    // 4-02-02-220 Interest Income has its own annex line inside 4-02.
    expect(captionFor('40202220', 'IN').caption).toBe('Interest Income');
    expect(captionFor('40202010', 'IN').caption).toBe('Receipts from business/service income');
  });
});

describe('buildCashFlows', () => {
  it('reports a voucher gross, and nets to the cash that actually left', () => {
    // Dr Office Supplies 100,000, Cr Cash 95,000, Cr Due to BIR 5,000.
    const s = build(
      jev([
        ['50203010', 100_000, 'Office Supplies Expenses'],
        ['10102010', -95_000, 'Cash in Bank'],
        ['20201010', -5_000, 'Due to BIR'],
      ]),
    );

    expect(find(s, 'Payments to suppliers and creditors').amount).toBe(100_000);
    // The tax withheld is money the LGU kept: a receipt, not a smaller payment.
    expect(find(s, 'Other Receipts').amount).toBe(5_000);
    expect(s.netFlows).toBe(-95_000);
    expect(s.tiesOut).toBe(true);
  });

  it('counts a collection once, not twice when it is deposited', () => {
    const entries = [
      // Collection: Dr Cash Collecting Officers, Cr Real Property Tax.
      ...jev([
        ['10101020', 50_000, 'Cash - Collecting Officers'],
        ['40101020', -50_000, 'Real Property Tax'],
      ]),
      // Deposit: Dr Cash in Bank, Cr Cash Collecting Officers. Cash to cash.
      ...jev([
        ['10102010', 50_000, 'Cash in Bank'],
        ['10101020', -50_000, 'Cash - Collecting Officers'],
      ]),
    ];
    const s = build(entries);

    expect(find(s, 'Collection from taxpayers').amount).toBe(50_000);
    expect(s.netFlows).toBe(50_000);
    expect(s.transferEntries).toBe(1);
    expect(s.cashEntries).toBe(1);
    expect(s.tiesOut).toBe(true);
  });

  it('reaches the tax caption when the collection clears a receivable instead', () => {
    // Where the tax was accrued first, the cash entry never names the income
    // account - it credits Real Property Tax Receivable.
    const s = build(
      jev([
        ['10101010', 30_000, 'Cash Local Treasury'],
        ['10301020', -30_000, 'Real Property Tax Receivable'],
      ]),
    );

    expect(find(s, 'Collection from taxpayers').amount).toBe(30_000);
    expect(find(s, 'Other Receipts').amount).toBe(0);
    expect(s.tiesOut).toBe(true);
  });

  it('ignores an entry that moved no cash', () => {
    const s = build(
      jev([
        ['10301020', 80_000, 'Real Property Tax Receivable'],
        ['40101020', -80_000, 'Real Property Tax'],
      ]),
    );

    expect(s.netFlows).toBe(0);
    expect(s.cashEntries).toBe(0);
    expect(s.tiesOut).toBe(true);
  });

  it('puts equipment bought and sold under investing', () => {
    const entries = [
      ...jev([
        ['10705020', 500_000, 'Office Equipment'],
        ['10102010', -500_000, 'Cash in Bank'],
      ]),
      ...jev([
        ['10102010', 20_000, 'Cash in Bank'],
        ['10705020', -20_000, 'Office Equipment'],
      ]),
    ];
    const s = build(entries);
    const investing = s.blocks.find((b) => b.section === 'INVESTING')!;

    expect(find(s, 'Purchase/Construction of Property, Plant and Equipment').amount).toBe(500_000);
    expect(find(s, 'Proceeds from Sale/Disposal of Property, Plant and Equipment').amount).toBe(20_000);
    expect(investing.net).toBe(-480_000);
    expect(s.tiesOut).toBe(true);
  });

  it('puts a loan drawn and repaid under financing', () => {
    const entries = [
      ...jev([
        ['10102010', 1_000_000, 'Cash in Bank'],
        ['20102040', -1_000_000, 'Loans Payable - Domestic'],
      ]),
      ...jev([
        ['20102040', 100_000, 'Loans Payable - Domestic'],
        ['10102010', -100_000, 'Cash in Bank'],
      ]),
    ];
    const s = build(entries);
    const financing = s.blocks.find((b) => b.section === 'FINANCING')!;

    expect(find(s, 'Proceeds from Loans').amount).toBe(1_000_000);
    expect(find(s, 'Payment of loan amortization').amount).toBe(100_000);
    expect(financing.net).toBe(900_000);
    expect(s.tiesOut).toBe(true);
  });

  it('separates bonds from loans', () => {
    const s = build(
      jev([
        ['10102010', 2_000_000, 'Cash in Bank'],
        ['20102020', -2_000_000, 'Bonds Payable - Domestic'],
      ]),
    );

    expect(find(s, 'Proceeds from Issuance of Bonds').amount).toBe(2_000_000);
    expect(find(s, 'Proceeds from Loans').amount).toBe(0);
  });

  it('takes the opening balance entry as the opening line, not as a receipt', () => {
    const entries = [
      ...jev(
        [
          ['10102010', 700_000, 'Cash in Bank'],
          ['30101010', -700_000, 'Government Equity'],
        ],
        { sourceType: 'OPENING' },
      ),
      ...jev([
        ['50101010', 200_000, 'Salaries and Wages - Regular'],
        ['10102010', -200_000, 'Cash in Bank'],
      ]),
    ];
    const s = build(entries);

    expect(s.openingCash).toBe(700_000);
    expect(s.openingFromOpeningEntry).toBe(700_000);
    // The 700,000 must not appear as an operating receipt.
    expect(find(s, 'Other Receipts').amount).toBe(0);
    expect(find(s, 'Payments to employees').amount).toBe(200_000);
    expect(s.netFlows).toBe(-200_000);
    expect(s.closingCash).toBe(500_000);
    expect(s.closingCashPerLedger).toBe(500_000);
    expect(s.tiesOut).toBe(true);
  });

  it('carries the prior year closing balance into the opening line', () => {
    const s = build(
      jev([
        ['10102010', 40_000, 'Cash in Bank'],
        ['40202010', -40_000, 'Permit Fees'],
      ]),
      250_000,
    );

    expect(s.openingCash).toBe(250_000);
    expect(s.closingCash).toBe(290_000);
    expect(s.closingCashPerLedger).toBe(290_000);
    expect(s.tiesOut).toBe(true);
  });

  it('stops at the chosen period', () => {
    const entries = [
      ...jev(
        [
          ['10102010', 10_000, 'Cash in Bank'],
          ['40202010', -10_000, 'Permit Fees'],
        ],
        { period: 3 },
      ),
      ...jev(
        [
          ['10102010', 90_000, 'Cash in Bank'],
          ['40202010', -90_000, 'Permit Fees'],
        ],
        { period: 9 },
      ),
    ];
    const s = buildCashFlows({ entries, throughPeriod: 6, priorClosingCash: 0 });

    expect(find(s, 'Receipts from business/service income').amount).toBe(10_000);
    expect(s.closingCashPerLedger).toBe(10_000);
    expect(s.tiesOut).toBe(true);
  });

  it('surfaces a journal entry whose lines do not sum to zero', () => {
    const s = build(
      jev(
        [
          ['50203010', 100_000, 'Office Supplies Expenses'],
          ['10102010', -90_000, 'Cash in Bank'],
        ],
        { jevNo: 'JEV-2026-01-0007' },
      ),
    );

    expect(s.unbalanced).toEqual([{ jevNo: 'JEV-2026-01-0007', difference: 10_000 }]);
    // And the damage shows in the tie-out rather than being absorbed.
    expect(s.tiesOut).toBe(false);
    expect(s.drift).toBe(-10_000);
  });

  it('keeps the counterpart accounts behind each caption', () => {
    const s = build(
      jev([
        ['50101010', 300_000, 'Salaries and Wages - Regular'],
        ['50102010', 25_000, 'Personnel Economic Relief Allowance'],
        ['10102010', -325_000, 'Cash in Bank'],
      ]),
    );

    const row = find(s, 'Payments to employees');
    expect(row.amount).toBe(325_000);
    expect(row.accounts).toEqual([
      { accountCode: '50101010', accountName: 'Salaries and Wages - Regular', amount: 300_000 },
      { accountCode: '50102010', accountName: 'Personnel Economic Relief Allowance', amount: 25_000 },
    ]);
  });

  it('presents the Trust Fund on the shorter Annex 9-A face', () => {
    const entries = [
      ...jev([
        ['10102010', 90_000, 'Cash in Bank'],
        ['40404010', -90_000, 'Grants and Donations in Cash'],
      ]),
      ...jev([
        ['50299050', 40_000, 'Other Maintenance and Operating Expenses'],
        ['10102010', -40_000, 'Cash in Bank'],
      ]),
    ];
    const s = buildCashFlows({ entries, throughPeriod: 12, priorClosingCash: 0, fundCode: 'TF' });
    const operating = s.blocks.find((b) => b.section === 'OPERATING')!;

    // One inflow caption and two outflow captions, and no tax or allotment line.
    expect(operating.inflows.map((r) => r.caption)).toEqual(['Other Receipts']);
    expect(operating.outflows.map((r) => r.caption)).toEqual([
      'Payments to suppliers and creditors',
      'Other Expenses',
    ]);
    expect(find(s, 'Other Receipts').amount).toBe(90_000);
    expect(find(s, 'Payments to suppliers and creditors').amount).toBe(40_000);

    // Investing and financing print as bare headings, as the annex has them.
    expect(s.blocks.find((b) => b.section === 'INVESTING')!.inflows).toHaveLength(0);
    expect(s.blocks.find((b) => b.section === 'FINANCING')!.outflows).toHaveLength(0);
    expect(s.tiesOut).toBe(true);
  });

  it('still shows Trust Fund investing activity rather than losing it', () => {
    const s = buildCashFlows({
      entries: jev([
        ['10705020', 70_000, 'Office Equipment'],
        ['10102010', -70_000, 'Cash in Bank'],
      ]),
      throughPeriod: 12,
      priorClosingCash: 0,
      fundCode: 'TF',
    });

    expect(find(s, 'Purchase/Construction of Property, Plant and Equipment').amount).toBe(70_000);
    expect(s.netFlows).toBe(-70_000);
    expect(s.tiesOut).toBe(true);
  });

  it('ties out across a mixed year', () => {
    const entries = [
      ...jev(
        [
          ['10102010', 1_500_000, 'Cash in Bank'],
          ['30101010', -1_500_000, 'Government Equity'],
        ],
        { sourceType: 'OPENING' },
      ),
      ...jev([
        ['10101020', 400_000, 'Cash - Collecting Officers'],
        ['40106010', -400_000, 'Share from Internal Revenue Collections'],
      ]),
      ...jev([
        ['10102010', 400_000, 'Cash in Bank'],
        ['10101020', -400_000, 'Cash - Collecting Officers'],
      ]),
      ...jev([
        ['50101010', 250_000, 'Salaries and Wages - Regular'],
        ['10102010', -230_000, 'Cash in Bank'],
        ['20201010', -20_000, 'Due to BIR'],
      ]),
      ...jev([
        ['10705020', 300_000, 'Office Equipment'],
        ['10102010', -300_000, 'Cash in Bank'],
      ]),
      ...jev([
        ['20102040', 50_000, 'Loans Payable - Domestic'],
        ['10102010', -50_000, 'Cash in Bank'],
      ]),
      // An accrual, touching no cash at all.
      ...jev([
        ['50501040', 60_000, 'Depreciation - Machinery and Equipment'],
        ['10705021', -60_000, 'Accumulated Depreciation - Office Equipment'],
      ]),
    ];
    const s = build(entries);

    expect(find(s, 'Share from Internal Revenue Allotment').amount).toBe(400_000);
    expect(find(s, 'Payments to employees').amount).toBe(250_000);
    expect(find(s, 'Other Receipts').amount).toBe(20_000);
    expect(find(s, 'Purchase/Construction of Property, Plant and Equipment').amount).toBe(300_000);
    expect(find(s, 'Payment of loan amortization').amount).toBe(50_000);

    expect(s.openingCash).toBe(1_500_000);
    expect(s.netFlows).toBe(400_000 - 250_000 + 20_000 - 300_000 - 50_000);
    expect(s.closingCash).toBe(1_320_000);
    expect(s.closingCashPerLedger).toBe(1_320_000);
    expect(s.tiesOut).toBe(true);
    expect(s.unbalanced).toHaveLength(0);
  });
});
