import { describe, it, expect } from 'vitest';
import {
  buildRstf,
  totalRstf,
  type RstfCollection,
  type RstfObligation,
  type RstfProgram,
} from './rstf';

const prog = (over: Partial<RstfProgram> = {}): RstfProgram => ({
  id: 'TP1',
  programCode: 'TF-2025-001',
  programName: 'Farm to Market Road - Barangay Payauan',
  sourceAgency: 'Department of Agriculture',
  reference: 'MOA dated 12 March 2025',
  accountCode: '20401040',
  startYear: 2025,
  programmed: 10_000_000_00,
  received: 10_000_000_00,
  receivedPosted: 10_000_000_00,
  utilised: 6_000_000_00,
  disbursed: 4_500_000_00,
  status: 'ACTIVE',
  ...over,
});

const furs = (over: Partial<RstfObligation> = {}): RstfObligation => ({
  obrNo: 'FURS-2026-0007',
  obrDate: '2026-03-14',
  status: 'OBLIGATED',
  particulars: 'Road base course, Station 0+000 to 0+500',
  lines: [{ trustProgramId: 'TP1', amount: 1_200_000_00 }],
  ...over,
});

const MARCH = { from: '2026-03-01', to: '2026-03-31' };

/** The sheets alone, which is what most of these tests are about. */
const build = (
  programs: RstfProgram[],
  obligations: RstfObligation[],
  over: Partial<Parameters<typeof buildRstf>[0]> = {},
) => buildRstf({ programs, obligations, ...MARCH, ...over }).sheets;

/** The whole register, for the tests about receipts that reach no sheet. */
const buildAll = (
  programs: RstfProgram[],
  obligations: RstfObligation[],
  over: Partial<Parameters<typeof buildRstf>[0]> = {},
) => buildRstf({ programs, obligations, ...MARCH, ...over });

const receipt = (over: Partial<RstfCollection> = {}): RstfCollection => ({
  orNumber: '7707731',
  orDate: '2026-03-10',
  payorName: 'Department of Agriculture',
  status: 'DEPOSITED',
  lines: [{ trustProgramId: 'TP1', amount: 2_000_000_00 }],
  ...over,
});

describe('one sheet per trust programme', () => {
  it('opens a sheet even for a programme with no activity in the period', () => {
    const sheets = build([prog()], []);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].utilisations).toEqual([]);
    expect(sheets[0].utilisedThisPeriod).toBe(0);
  });

  it('orders sheets by source agency, then by programme', () => {
    const sheets = build(
      [
        prog({ id: 'B', sourceAgency: 'Provincial Government' }),
        prog({ id: 'A', sourceAgency: 'Department of Agriculture' }),
      ],
      [],
    );
    expect(sheets.map((s) => s.program.id)).toEqual(['A', 'B']);
  });

  it('can be limited to programmes still running', () => {
    const programs = [prog(), prog({ id: 'TP2', status: 'CLOSED', sourceAgency: 'DILG' })];
    expect(build(programs, [])).toHaveLength(2);
    expect(build(programs, [], { activeOnly: true })).toHaveLength(1);
  });
});

describe('the Utilization side', () => {
  it('lists a FURS inside the period', () => {
    const [sheet] = build([prog()], [furs()]);
    expect(sheet.utilisations).toHaveLength(1);
    expect(sheet.utilisations[0].reference).toBe('FURS-2026-0007');
    expect(sheet.utilisedThisPeriod).toBe(1_200_000_00);
  });

  it('leaves out a FURS outside the period, on either side', () => {
    expect(build([prog()], [furs({ obrDate: '2026-02-28' })])[0].utilisations).toHaveLength(0);
    expect(build([prog()], [furs({ obrDate: '2026-04-01' })])[0].utilisations).toHaveLength(0);
  });

  /**
   * The server adds to `utilised` when a request is CERTIFIED and takes it
   * back when the request is cancelled. Anything looser here - counting a
   * SUBMITTED or a RETURNED request - would make the listed lines add up to
   * more than the programme figure printed beside them on the same sheet.
   */
  it.each(['CERTIFIED', 'OBLIGATED', 'PAID', 'CLOSED'])('counts a %s request', (status) => {
    expect(build([prog()], [furs({ status })])[0].utilisedThisPeriod).toBe(1_200_000_00);
  });

  it.each(['DRAFT', 'SUBMITTED', 'BUDGET_REVIEWED', 'RETURNED', 'CANCELLED'])(
    'ignores a %s request',
    (status) => {
      expect(build([prog()], [furs({ status })])[0].utilisedThisPeriod).toBe(0);
    },
  );

  it('merges two lines of one request against the same programme', () => {
    const [sheet] = build(
      [prog()],
      [
        furs({
          lines: [
            { trustProgramId: 'TP1', amount: 700_000_00 },
            { trustProgramId: 'TP1', amount: 500_000_00 },
          ],
        }),
      ],
    );
    expect(sheet.utilisations).toHaveLength(1);
    expect(sheet.utilisations[0].amount).toBe(1_200_000_00);
  });

  it('puts a line for another programme on the other sheet', () => {
    const sheets = build(
      [prog(), prog({ id: 'TP2', sourceAgency: 'DILG' })],
      [
        furs({
          lines: [
            { trustProgramId: 'TP1', amount: 700_000_00 },
            { trustProgramId: 'TP2', amount: 300_000_00 },
          ],
        }),
      ],
    );
    expect(sheets.find((s) => s.program.id === 'TP1')!.utilisedThisPeriod).toBe(700_000_00);
    expect(sheets.find((s) => s.program.id === 'TP2')!.utilisedThisPeriod).toBe(300_000_00);
  });

  it('ignores a line charged to no programme at all', () => {
    const [sheet] = build([prog()], [furs({ lines: [{ amount: 50_000_00 }] })]);
    expect(sheet.utilisedThisPeriod).toBe(0);
  });

  it('lists requests by date, then by number', () => {
    const [sheet] = build(
      [prog()],
      [
        furs({ obrDate: '2026-03-20', obrNo: 'FURS-2026-0011' }),
        furs({ obrDate: '2026-03-03', obrNo: 'FURS-2026-0005' }),
        furs({ obrDate: '2026-03-03', obrNo: 'FURS-2026-0004' }),
      ],
    );
    expect(sheet.utilisations.map((e) => e.reference)).toEqual([
      'FURS-2026-0004',
      'FURS-2026-0005',
      'FURS-2026-0011',
    ]);
  });
});

/**
 * Instruction 3: "The SL shall not be closed at the end of the year."
 *
 * The period figure and the life-to-date figure are two different things and
 * are reported as two. They are NOT subtracted from one another to make a
 * brought-forward line - see the note at the head of rstf.ts.
 */
describe('the figures that span years', () => {
  it('keeps the period figure and the life-to-date figure apart', () => {
    const [sheet] = build([prog()], [furs()]);
    expect(sheet.utilisedThisPeriod).toBe(1_200_000_00);
    expect(sheet.utilisedToDate).toBe(6_000_000_00);
  });

  it('takes the life-to-date figures from the programme, not from the listed lines', () => {
    const [withLines] = build([prog()], [furs()]);
    const [without] = build([prog()], []);
    expect(withLines.utilisedToDate).toBe(without.utilisedToDate);
    expect(withLines.disbursedToDate).toBe(4_500_000_00);
  });
});

describe('the balances', () => {
  it('strikes the balance as received less utilised, life to date', () => {
    const [sheet] = build([prog()], []);
    expect(sheet.balance).toBe(4_000_000_00);
  });

  it('goes negative when more was committed than was received', () => {
    const [sheet] = build([prog({ receivedPosted: 5_000_000_00 })], []);
    expect(sheet.balance).toBe(-1_000_000_00);
  });

  it('strikes the balance on the receipts, not on the stated figure', () => {
    // The source promised ten million and has receipted five. Six is already
    // committed, so the programme is overdrawn against what actually arrived -
    // and striking the balance on the promise would hide that.
    const [sheet] = build([prog({ received: 10_000_000_00, receivedPosted: 5_000_000_00 })], []);
    expect(sheet.balance).toBe(-1_000_000_00);
    expect(sheet.receiptStated).toBe(10_000_000_00);
    expect(sheet.receiptDrift).toBe(5_000_000_00);
  });

  it('reports what is committed and not yet paid', () => {
    expect(build([prog()], [])[0].unpaidUtilisations).toBe(1_500_000_00);
  });

  it('reports what a further request may still draw on', () => {
    expect(build([prog()], [])[0].availableToUtilise).toBe(4_000_000_00);
  });
});

describe('the receipt side', () => {
  it('lists one dated line per official receipt reported', () => {
    const [sheet] = build([prog()], [], {
      collections: [
        receipt({ orNumber: '7707731', orDate: '2026-03-10', lines: [{ trustProgramId: 'TP1', amount: 2_000_000_00 }] }),
        receipt({ orNumber: '7707728', orDate: '2026-03-04', lines: [{ trustProgramId: 'TP1', amount: 500_000_00 }] }),
      ],
    });

    // Oldest first, which is the order a register is written up in.
    expect(sheet.receipts.map((r) => r.reference)).toEqual(['7707728', '7707731']);
    expect(sheet.receipts[0].date).toBe('2026-03-04');
    expect(sheet.receivedThisPeriod).toBe(2_500_000_00);
  });

  it('merges two lines of one receipt into the one line', () => {
    const [sheet] = build([prog()], [], {
      collections: [
        receipt({
          lines: [
            { trustProgramId: 'TP1', amount: 1_000_000_00 },
            { trustProgramId: 'TP1', amount: 250_000_00 },
          ],
        }),
      ],
    });

    expect(sheet.receipts).toHaveLength(1);
    expect(sheet.receipts[0].amount).toBe(1_250_000_00);
  });

  it('leaves out a receipt that has not been reported on an RCD', () => {
    // receivedPosted is written when the RCD is posted, so a receipt still in
    // the drawer is not in the total. Listing it would put a line on the sheet
    // that the total beside it does not include.
    const [sheet] = build([prog()], [], {
      collections: [receipt({ status: 'ISSUED' })],
    });

    expect(sheet.receipts).toEqual([]);
  });

  it('counts only the receipts falling inside the period', () => {
    const [sheet] = build([prog()], [], {
      collections: [
        receipt({ orNumber: 'A', orDate: '2026-02-20', lines: [{ trustProgramId: 'TP1', amount: 900_000_00 }] }),
        receipt({ orNumber: 'B', orDate: '2026-03-20', lines: [{ trustProgramId: 'TP1', amount: 100_000_00 }] }),
      ],
    });

    // Both are on the sheet - the register is life-to-date - but only one
    // falls in March.
    expect(sheet.receipts).toHaveLength(2);
    expect(sheet.receivedThisPeriod).toBe(100_000_00);
  });

  it('keeps a receipt for another programme off this sheet', () => {
    const [sheet] = build([prog()], [], {
      collections: [receipt({ lines: [{ trustProgramId: 'TP-OTHER', amount: 300_000_00 }] })],
    });

    expect(sheet.receipts).toEqual([]);
  });

  it('carries the year the trust was granted', () => {
    expect(build([prog()], [])[0].receiptYear).toBe(2025);
    expect(build([prog({ startYear: undefined })], [])[0].receiptYear).toBeNull();
  });
});

describe('the registry total', () => {
  it('adds the sheets up', () => {
    const t = totalRstf(
      build(
        [
          // received 10M, utilised 6M, disbursed 4.5M
          prog(),
          prog({
            id: 'TP2',
            sourceAgency: 'DILG',
            received: 2_000_000_00,
            receivedPosted: 2_000_000_00,
            utilised: 1_000_000_00,
            disbursed: 1_000_000_00,
          }),
        ],
        [furs()],
      ),
    );
    expect(t.received).toBe(12_000_000_00);
    expect(t.utilisedThisPeriod).toBe(1_200_000_00);
    expect(t.utilisedToDate).toBe(7_000_000_00);
    expect(t.balance).toBe(5_000_000_00);
    expect(t.unpaidUtilisations).toBe(1_500_000_00);
  });
});

describe('a receipt that names no programme', () => {
  /**
   * The link is optional, because refusing a receipt for want of master data
   * would stop the Treasury taking money in. What that costs is a receipt that
   * belongs on some sheet and is on none - so it is named here rather than
   * quietly left out, which is the only way anybody finds it.
   */
  it('is listed by receipt number, not dropped', () => {
    const r = buildAll([prog()], [], {
      collections: [
        receipt({
          orNumber: '7707740',
          orDate: '2026-03-18',
          payorName: 'Provincial Government',
          lines: [{ amount: 750_000_00 }],
        }),
      ],
    });

    expect(r.unattributed).toEqual([
      {
        orNumber: '7707740',
        orDate: '2026-03-18',
        payorName: 'Provincial Government',
        amount: 750_000_00,
      },
    ]);
    expect(r.unattributedTotal).toBe(750_000_00);
    // And it is on no sheet.
    expect(r.sheets[0].receipts).toEqual([]);
  });

  it('counts only the lines that name no programme, not the whole receipt', () => {
    const r = buildAll([prog()], [], {
      collections: [
        receipt({
          lines: [
            { trustProgramId: 'TP1', amount: 400_000_00 },
            { amount: 100_000_00 },
          ],
        }),
      ],
    });

    expect(r.sheets[0].receipts[0].amount).toBe(400_000_00);
    expect(r.unattributedTotal).toBe(100_000_00);
  });

  it('ignores one that has not been reported yet', () => {
    const r = buildAll([prog()], [], {
      collections: [receipt({ status: 'ISSUED', lines: [{ amount: 50_000_00 }] })],
    });

    expect(r.unattributed).toEqual([]);
  });

  it('lists the newest first, because that is the one still fixable', () => {
    const r = buildAll([prog()], [], {
      collections: [
        receipt({ orNumber: 'OLD', orDate: '2026-01-05', lines: [{ amount: 10_000_00 }] }),
        receipt({ orNumber: 'NEW', orDate: '2026-03-22', lines: [{ amount: 20_000_00 }] }),
      ],
    });

    expect(r.unattributed.map((u) => u.orNumber)).toEqual(['NEW', 'OLD']);
  });

  it('is empty when every reported receipt names its programme', () => {
    const r = buildAll([prog()], [], { collections: [receipt()] });
    expect(r.unattributed).toEqual([]);
    expect(r.unattributedTotal).toBe(0);
  });
});

describe('a programme recorded before the receipts were worked', () => {
  /**
   * Its document carries no `receivedPosted`, and `undefined - utilised` is
   * NaN - which would print as "NaN" in the balance column of every sheet in
   * the register rather than failing anywhere a test would see it.
   */
  it('reads as nil received rather than as nothing at all', () => {
    const old = { ...prog(), receivedPosted: undefined };
    const [sheet] = build([old], []);

    expect(sheet.receiptTotal).toBe(0);
    expect(sheet.balance).toBe(-6_000_000_00);
    expect(Number.isNaN(sheet.balance)).toBe(false);
    // And the whole stated figure shows as drift, which is the thing to fix.
    expect(sheet.receiptDrift).toBe(10_000_000_00);
  });

  it('keeps the registry total a number', () => {
    const t = totalRstf(build([{ ...prog(), receivedPosted: undefined }], []));
    expect(Number.isNaN(t.received)).toBe(false);
    expect(t.received).toBe(0);
  });
});
