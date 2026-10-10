import { describe, expect, it } from 'vitest';
import {
  ageBucket,
  buildForm11,
  buildForm12,
  buildForm6,
  buildForm8,
  buildForm9,
  form9KeyFor,
  quarterRange,
  trustSourceOf,
} from './fdpp';
import type { BudgetBalance, TrustProgram } from '@/types/budget';
import type { CashFlowStatement } from '@/pages/reports/cashFlows';

const prog = (p: Partial<TrustProgram>): TrustProgram =>
  ({
    id: p.programCode ?? 'x',
    programCode: 'TRUST1',
    programName: 'X',
    sourceAgency: '',
    reference: '',
    programmed: 0,
    received: 0,
    receivedPosted: 0,
    receiptDrift: 0,
    utilised: 0,
    disbursed: 0,
    availableToUtilise: 0,
    unpaidUtilisations: 0,
    status: 'ACTIVE',
    updatedAt: '2026-01-01',
    ...p,
  }) as TrustProgram;

describe('FDPP reports (patch 163)', () => {
  it('knows the quarter', () => {
    expect(quarterRange(2025, 4)).toMatchObject({
      from: '2025-10-01',
      to: '2025-12-31',
      lastPeriod: 12,
    });
    expect(quarterRange(2024, 1).to).toBe('2024-03-31');
  });

  it('Form 6 reports only programmes funded by other agencies', () => {
    const rows = buildForm6(
      [
        prog({
          programCode: 'TRUST124',
          programName: 'DSWD SOCIAL PENSION PROGRAM',
          sourceAgency: 'DSWD',
          programmed: 100_00,
          utilised: 100_00,
        }),
        prog({ programCode: 'TRUST010', programName: 'BAC FEES', sourceAgency: 'LGU' }),
        prog({
          programCode: 'TRUST011',
          programName: 'Town fiesta',
          fundSource: 'NATIONAL',
          programmed: 50_00,
          utilised: 20_00,
          percentComplete: 75,
        }),
        prog({ programCode: 'TRUST012', programName: 'LDRRMF 2023', sourceAgency: 'LGU' }),
        prog({
          programCode: 'TRUST013',
          programName: 'Old',
          sourceAgency: 'DOH',
          status: 'CLOSED',
          updatedAt: '2024-05-01',
        }),
      ],
      2025,
    );
    expect(rows.map((r) => r.program)).toEqual([
      'TRUST011 - Town fiesta',
      'TRUST124 - DSWD SOCIAL PENSION PROGRAM',
    ]);
    expect(rows[0]).toMatchObject({
      percentComplete: 75,
      costIncurred: 20_00,
      remarks: 'On-going',
      inferred: false,
    });
    expect(rows[1]).toMatchObject({
      percentComplete: 100,
      remarks: 'Fully utilized',
      location: 'CANDONI',
      inferred: true,
    });
    expect(
      trustSourceOf({
        programName: 'PhilHealth hospital charges',
        sourceAgency: 'PhilHealth',
        fundSource: null,
      }).source,
    ).toBe('OWN');
  });

  it('Form 8 splits the QRF from the 70% and carries the Special Trust Fund', () => {
    const bal = (b: Partial<BudgetBalance>) =>
      ({
        sector: 'LDRRMF',
        expenseClass: 'MOOE',
        fppName: '',
        accountName: '',
        appropriationContinuing: 0,
        appropriationRevised: 0,
        obligated: 0,
        ...b,
      }) as BudgetBalance;
    const f = buildForm8({
      balances: [
        bal({ fppName: 'Quick Response Fund', appropriationRevised: 300_00, obligated: 100_00 }),
        bal({
          fppName: 'Disaster preparedness',
          accountName: 'Training Expenses',
          appropriationRevised: 700_00,
          obligated: 200_00,
        }),
        bal({
          fppName: 'Rescue vehicle',
          expenseClass: 'CO',
          appropriationRevised: 50_00,
          appropriationContinuing: 50_00,
          obligated: 50_00,
        }),
        bal({ sector: 'General Public Services', appropriationRevised: 999_00 }),
      ],
      trustPrograms: [
        prog({
          programCode: 'TRUST200',
          programName: 'LDRRMF 2023',
          startYear: 2023,
          programmed: 80_00,
          utilised: 30_00,
        }),
      ],
      year: 2025,
    });
    expect(f.sources[0]).toMatchObject({ qrf: 300_00, seventy: 700_00 });
    expect(f.sources[1]).toMatchObject({ seventy: 50_00 });
    expect(f.sources.find((s) => s.label === 'STF 2023')).toMatchObject({ seventy: 80_00 });
    expect(f.totalAvailable).toEqual({ qrf: 300_00, seventy: 830_00 });
    expect(f.utilization[0].groups.map((g) => g.label)).toEqual([
      'Quick Response Fund',
      'Maintenance and Other Operating Expenses',
    ]);
    expect(f.utilization[0].groups[1].items[0]).toMatchObject({
      label: 'Disaster preparedness - Training Expenses',
      budget: 700_00,
      remaining: 500_00,
    });
    expect(f.totalUtilization).toEqual({ qrf: 100_00, seventy: 280_00 });
    expect(f.unutilized).toEqual({ qrf: 200_00, seventy: 550_00 });
  });

  it('Form 9 puts the GAM captions on the Annex 2 lines and works the quarter out of year-to-date', () => {
    expect(form9KeyFor('OPERATING', 'IN', 'Share from Internal Revenue Allotment')).toBe('IRA');
    expect(form9KeyFor('OPERATING', 'IN', 'Receipts from business/service income')).toBe('SALES');
    expect(form9KeyFor('OPERATING', 'OUT', 'Payments to suppliers and creditors')).toBe(
      'SUPPLIERS',
    );
    expect(
      form9KeyFor('INVESTING', 'OUT', 'Purchase/Construction of Property, Plant and Equipment'),
    ).toBe('BUY_PPE');
    expect(form9KeyFor('FINANCING', 'IN', 'Proceeds from Loans')).toBe('LOANS');
    const st = (ira: number, emp: number, opening: number, closing: number) =>
      ({
        blocks: [
          {
            section: 'OPERATING',
            inflows: [{ caption: 'Share from Internal Revenue Allotment', amount: ira }],
            outflows: [{ caption: 'Payments to employees', amount: emp }],
          },
        ],
        openingCash: opening,
        closingCash: closing,
        tiesOut: true,
      }) as unknown as CashFlowStatement;
    const ytd = buildForm9([st(1000, 400, 100, 700), st(10, 0, 0, 10)]);
    expect(ytd.amounts.IRA).toBe(1010);
    expect(ytd.amounts.EMPLOYEES).toBe(-400);
    expect(ytd.totals.OPERATING).toEqual({ in: 1010, out: -400, net: 610 });
    expect(ytd).toMatchObject({ opening: 100, closing: 710, netIncrease: 610 });
    const q = buildForm9([st(1000, 400, 100, 700)], [st(600, 100, 100, 600)]);
    expect(q.amounts.IRA).toBe(400);
    expect(q).toMatchObject({ opening: 600, netIncrease: 100, closing: 700 });
  });

  it('Form 11 breaks the SEF disbursements down by class and object', () => {
    const f = buildForm11({
      receipts: 1000_00,
      vouchers: [
        {
          lines: [
            { accountCode: '50203010', accountName: 'Office Supplies Expenses', debit: 90_00 },
            {
              accountCode: '10405020',
              accountName: 'Semi-Expendable Office Equipment',
              debit: 45_00,
            },
            { accountCode: '20101010', accountName: 'Accounts Payable', debit: 0 },
            { accountCode: '10101010', accountName: 'Cash', debit: 5_00 },
          ],
        },
        {
          lines: [
            { accountCode: '50203010', accountName: 'Office Supplies Expenses', debit: 10_00 },
          ],
        },
      ],
    });
    expect(f.classes[1].objects).toEqual([{ name: 'Office Supplies Expenses', amount: 100_00 }]);
    expect(f.classes[2].total).toBe(45_00);
    expect(f).toMatchObject({ subtotal: 145_00, balance: 855_00 });
  });

  it('Form 12 ages each advance at the quarter end, debtors in alphabetical order', () => {
    expect(ageBucket('2025-12-10', '2025-12-31')).toBe(0);
    expect(ageBucket('2025-11-01', '2025-12-31')).toBe(1);
    expect(ageBucket('2025-06-30', '2025-12-31')).toBe(2);
    expect(ageBucket('2024-06-30', '2025-12-31')).toBe(3);
    expect(ageBucket('2023-06-30', '2025-12-31')).toBe(4);
    expect(ageBucket('2018-07-03', '2025-12-31')).toBe(5);
    const r = buildForm12(
      [
        {
          id: 'a',
          accountableOfficerName: 'Pilar, Angelo',
          outstandingBalance: 2_802_00,
          dateGranted: '2018-07-03',
          purpose: 'Travel',
          fundCode: 'GF',
        },
        {
          id: 'b',
          accountableOfficerName: 'Bacus, John',
          outstandingBalance: 7_600_00,
          dateGranted: '2025-12-20',
          purpose: 'Training',
          fundCode: 'SEF',
        },
        {
          id: 'c',
          accountableOfficerName: 'Late',
          outstandingBalance: 1_00,
          dateGranted: '2026-01-05',
          purpose: '',
          fundCode: 'TF',
        },
        {
          id: 'd',
          accountableOfficerName: 'Settled',
          outstandingBalance: 0,
          dateGranted: '2025-01-05',
          purpose: '',
          fundCode: 'TF',
        },
      ],
      '2025-12-31',
    );
    expect(r.rows.map((x) => x.name)).toEqual(['BACUS, JOHN', 'PILAR, ANGELO']);
    expect(r.buckets).toEqual([7_600_00, 0, 0, 0, 0, 2_802_00]);
    expect(r.total).toBe(10_402_00);
  });
});
