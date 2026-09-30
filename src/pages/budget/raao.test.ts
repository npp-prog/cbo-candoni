import { describe, it, expect } from 'vitest';
import { buildRaao, totalRaao, RAAO_FORMS, type RaaoAllotment, type RaaoObligation } from './raao';
import { figuresForPeriod } from '@/lib/budgetPeriods';

/**
 * The registry is a book an auditor reads, so these tests are about it
 * FOOTING, not about it rendering. A register that adds up wrongly is worse
 * than no register: it is evidence of a figure nobody can trace.
 */

const allot = (over: Partial<RaaoAllotment> = {}): RaaoAllotment => ({
  allotmentDate: '2026-03-10',
  status: 'APPROVED',
  officeId: 'OFF1',
  officeName: 'Municipal Engineering Office',
  fppCode: '8751',
  fppName: 'Engineering Services',
  accountCode: '50203010',
  expenseClass: 'MOOE',
  amount: 100_000_00,
  aroNo: 'ARO-2026-001',
  particulars: 'First release',
  ...over,
});

const oblig = (over: Partial<RaaoObligation> = {}): RaaoObligation => ({
  obrNo: 'OBR-2026-0001',
  obrDate: '2026-03-15',
  status: 'OBLIGATED',
  particulars: 'Fuel for March',
  lines: [
    {
      officeId: 'OFF1',
      officeName: 'Municipal Engineering Office',
      fppCode: '8751',
      fppName: 'Engineering Services',
      appropriatedAccountCode: '50203010',
      expenseClass: 'MOOE',
      amount: 40_000_00,
    },
  ],
  ...over,
});

const MARCH = { from: '2026-03-01', to: '2026-03-31' };

const build = (
  allotments: RaaoAllotment[],
  obligations: RaaoObligation[],
  over: Partial<Parameters<typeof buildRaao>[0]> = {},
) =>
  buildRaao({
    expenseClass: 'MOOE',
    allotments,
    obligations,
    appropriations: [],
    ...MARCH,
    ...over,
  });

describe('the four registries', () => {
  it('names an appendix for each allotment class', () => {
    expect(RAAO_FORMS.CO.appendix).toBe(19);
    expect(RAAO_FORMS.MOOE.appendix).toBe(20);
    expect(RAAO_FORMS.PS.appendix).toBe(21);
    expect(RAAO_FORMS.FE.appendix).toBe(22);
  });

  it('keeps an allotment of one class out of the other registries', () => {
    const co = allot({ expenseClass: 'CO', amount: 500_000_00 });
    expect(build([co], [])).toHaveLength(0);
    expect(build([co], [], { expenseClass: 'CO' })).toHaveLength(1);
  });
});

describe('what the period includes', () => {
  it('lists an allotment inside the period', () => {
    const [sheet] = build([allot()], []);
    expect(sheet.budget.entries).toHaveLength(1);
    expect(sheet.budget.thisPeriod).toBe(100_000_00);
    expect(sheet.budget.broughtForward).toBe(0);
  });

  /**
   * Instruction 7: the previous months' totals go on the first line, not into
   * the body. Listing January's releases again in the March sheet would double
   * the register every month it is reprinted.
   */
  it('brings an earlier allotment forward instead of listing it', () => {
    const [sheet] = build([allot({ allotmentDate: '2026-01-20' })], []);
    expect(sheet.budget.entries).toHaveLength(0);
    expect(sheet.budget.broughtForward).toBe(100_000_00);
    expect(sheet.budget.thisPeriod).toBe(0);
  });

  it('leaves out anything dated after the period', () => {
    expect(build([allot({ allotmentDate: '2026-04-01' })], [])).toHaveLength(0);
  });

  it('adds the brought-forward figure and the month to get the accumulated total', () => {
    const [sheet] = build(
      [allot({ allotmentDate: '2026-01-20', amount: 60_000_00 }), allot()],
      [],
    );
    expect(sheet.budget.broughtForward).toBe(60_000_00);
    expect(sheet.budget.thisPeriod).toBe(100_000_00);
    expect(sheet.budget.toDate).toBe(160_000_00);
  });
});

describe('what counts as released and as committed', () => {
  it.each(['DRAFT', 'CANCELLED'])('ignores a %s allotment', (status) => {
    expect(build([allot({ status })], [])).toHaveLength(0);
  });

  it.each(['CERTIFIED', 'OBLIGATED', 'PAID', 'CLOSED'])('counts a %s obligation', (status) => {
    const [sheet] = build([], [oblig({ status })]);
    expect(sheet.actual.thisPeriod).toBe(40_000_00);
  });

  it.each(['DRAFT', 'SUBMITTED', 'BUDGET_REVIEWED', 'RETURNED', 'CANCELLED'])(
    'ignores a %s obligation',
    (status) => {
      expect(build([], [oblig({ status })])).toHaveLength(0);
    },
  );
});

describe('the unobligated balance', () => {
  /** Instruction 11, and the one figure the whole form exists to produce. */
  it('is the accumulated allotment less the accumulated obligation', () => {
    const [sheet] = build(
      [allot({ allotmentDate: '2026-02-01', amount: 200_000_00 }), allot()],
      [oblig({ obrDate: '2026-02-10' }), oblig({ obrNo: 'OBR-2026-0002' })],
    );
    expect(sheet.budget.toDate).toBe(300_000_00);
    expect(sheet.actual.toDate).toBe(80_000_00);
    expect(sheet.unobligatedBalance).toBe(220_000_00);
  });

  it('goes negative when more was committed than released, rather than clamping', () => {
    const [sheet] = build([allot({ amount: 10_000_00 })], [oblig()]);
    expect(sheet.unobligatedBalance).toBe(-30_000_00);
  });
});

describe('the Details columns', () => {
  it('heads them with the object codes the sheet actually uses, in code order', () => {
    const [sheet] = build(
      [
        allot({ accountCode: '50203090' }),
        allot({ accountCode: '50201010' }),
        allot({ accountCode: '50203090' }),
      ],
      [],
    );
    expect(sheet.accountCodes).toEqual(['50201010', '50203090']);
  });

  it('splits every entry across the columns so the split sums to the entry', () => {
    const [sheet] = build([allot()], []);
    const e = sheet.budget.entries[0];
    expect(Object.values(e.byAccount).reduce((a, b) => a + b, 0)).toBe(e.amount);
  });

  it('foots each column to the section total', () => {
    const [sheet] = build(
      [allot({ accountCode: '50201010', amount: 30_000_00 }), allot({ amount: 70_000_00 })],
      [],
    );
    const sum = Object.values(sheet.budget.thisPeriodByAccount).reduce((a, b) => a + b, 0);
    expect(sum).toBe(sheet.budget.thisPeriod);
    expect(sum).toBe(100_000_00);
  });

  it('carries the brought-forward split into the accumulated split', () => {
    const [sheet] = build(
      [
        allot({ allotmentDate: '2026-01-05', accountCode: '50201010', amount: 25_000_00 }),
        allot({ accountCode: '50201010', amount: 5_000_00 }),
      ],
      [],
    );
    expect(sheet.budget.toDateByAccount['50201010']).toBe(30_000_00);
  });

  /**
   * On a project line the appropriation carries no object code and the
   * obligation does. Keying the Details column on the obligation's own code
   * would open a column the allotment never released into, and the sheet would
   * show an obligation with no allotment above it.
   */
  it('uses the code the appropriation carried, not the one the obligation commits', () => {
    const [sheet] = build(
      [],
      [
        oblig({
          lines: [
            {
              officeId: 'OFF1',
              officeName: 'Municipal Engineering Office',
              fppCode: 'PROJ-01',
              appropriatedAccountCode: '50203010',
              expenseClass: 'MOOE',
              amount: 40_000_00,
            },
          ],
        }),
      ],
    );
    expect(sheet.actual.entries[0].byAccount).toEqual({ '50203010': 40_000_00 });
  });
});

describe('one Obligation Request, several lines', () => {
  it('merges lines charged to the same sheet into one register entry', () => {
    const line = {
      officeId: 'OFF1',
      officeName: 'Municipal Engineering Office',
      fppCode: '8751',
      appropriatedAccountCode: '50203010',
      expenseClass: 'MOOE',
      amount: 20_000_00,
    };
    const [sheet] = build([], [oblig({ lines: [line, { ...line, amount: 15_000_00 }] })]);
    expect(sheet.actual.entries).toHaveLength(1);
    expect(sheet.actual.entries[0].amount).toBe(35_000_00);
  });

  it('opens a sheet of its own for a line charged to another function', () => {
    const base = {
      officeId: 'OFF1',
      officeName: 'Municipal Engineering Office',
      appropriatedAccountCode: '50203010',
      expenseClass: 'MOOE',
      amount: 20_000_00,
    };
    const sheets = build(
      [],
      [oblig({ lines: [{ ...base, fppCode: '8751' }, { ...base, fppCode: '8752' }] })],
    );
    expect(sheets.map((s) => s.fppCode)).toEqual(['8751', '8752']);
  });
});

describe('what appears on the sheet at all', () => {
  it('prints a function that was appropriated but never drawn on', () => {
    const sheets = build([], [], {
      appropriations: [
        {
          officeId: 'OFF1',
          fppCode: '8751',
          accountCode: '50203010',
          expenseClass: 'MOOE',
          appropriationRevised: 500_000_00,
        },
      ],
    });
    expect(sheets).toHaveLength(1);
    expect(sheets[0].appropriation).toBe(500_000_00);
    expect(sheets[0].unobligatedBalance).toBe(0);
  });

  it('prints nothing for a function with no appropriation and no activity', () => {
    expect(build([], [])).toHaveLength(0);
  });

  it('honours the office filter', () => {
    const other = allot({ officeId: 'OFF2', officeName: 'Municipal Health Office' });
    expect(build([allot(), other], [])).toHaveLength(2);
    expect(build([allot(), other], [], { officeId: 'OFF2' })).toHaveLength(1);
  });
});

describe('the order the register reads in', () => {
  it('lists entries by date, then by reference', () => {
    const sheets = build(
      [
        allot({ allotmentDate: '2026-03-20', aroNo: 'ARO-2026-009' }),
        allot({ allotmentDate: '2026-03-05', aroNo: 'ARO-2026-004' }),
        allot({ allotmentDate: '2026-03-05', aroNo: 'ARO-2026-002' }),
      ],
      [],
    );
    expect(sheets[0].budget.entries.map((e) => e.reference)).toEqual([
      'ARO-2026-002',
      'ARO-2026-004',
      'ARO-2026-009',
    ]);
  });

  it('falls back to the allotment number when a line carries no ARO', () => {
    const [sheet] = build([allot({ aroNo: undefined, allotmentNo: 'ALT-2026-77' })], []);
    expect(sheet.budget.entries[0].reference).toBe('ALT-2026-77');
  });
});

describe('a withdrawal of allotment', () => {
  /**
   * A negative release is a real line of the register, not a correction to be
   * netted away quietly. The sheet must show that authority was taken back.
   */
  it('appears as its own line and reduces the total', () => {
    const [sheet] = build(
      [allot(), allot({ amount: -30_000_00, aroNo: 'ARO-2026-002', particulars: 'Withdrawal' })],
      [],
    );
    expect(sheet.budget.entries).toHaveLength(2);
    expect(sheet.budget.thisPeriod).toBe(70_000_00);
  });
});

/**
 * The registry and the summary must agree.
 *
 * They are computed by different code off the same documents, which is the
 * point: if a change breaks one, this test says so before an auditor does.
 */
describe('agreement with the summary registry', () => {
  it('foots to the same allotment and obligation totals as figuresForPeriod', () => {
    const allotments = [
      allot({ allotmentDate: '2026-01-10', amount: 300_000_00 }),
      allot({ allotmentDate: '2026-03-02', amount: 120_000_00 }),
      allot({ allotmentDate: '2026-03-18', accountCode: '50201010', amount: 45_000_00 }),
      allot({ status: 'DRAFT', amount: 999_000_00 }),
    ];
    const obligations = [
      oblig({ obrNo: 'OBR-1', obrDate: '2026-02-11', lines: oblig().lines }),
      oblig({ obrNo: 'OBR-2', obrDate: '2026-03-09' }),
      oblig({ obrNo: 'OBR-3', obrDate: '2026-03-30', status: 'CANCELLED' }),
    ];

    const sheets = build(allotments, obligations);
    const t = totalRaao(sheets);

    const figures = figuresForPeriod(allotments, obligations, MARCH.from, MARCH.to);
    const summary = figures.reduce(
      (acc, f) => ({
        allotment: acc.allotment + f.allotmentPrevious + f.allotmentThisPeriod,
        obligation: acc.obligation + f.obligationPrevious + f.obligationThisPeriod,
        allotmentThisPeriod: acc.allotmentThisPeriod + f.allotmentThisPeriod,
        obligationThisPeriod: acc.obligationThisPeriod + f.obligationThisPeriod,
      }),
      { allotment: 0, obligation: 0, allotmentThisPeriod: 0, obligationThisPeriod: 0 },
    );

    expect(t.allotmentToDate).toBe(summary.allotment);
    expect(t.obligationToDate).toBe(summary.obligation);
    expect(t.allotmentThisPeriod).toBe(summary.allotmentThisPeriod);
    expect(t.obligationThisPeriod).toBe(summary.obligationThisPeriod);
    expect(t.unobligatedBalance).toBe(summary.allotment - summary.obligation);
  });
});
