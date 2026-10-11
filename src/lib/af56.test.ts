import { describe, expect, it } from 'vitest';
import { DISCOUNT_DEBIT_ACCOUNTS, reportedCashDebit } from './treasuryEntry';
import {
  AF56_ACCOUNTS,
  AF56_DISCOUNT_ACCOUNTS,
  af56Lines,
  af56LinesAgree,
  af56ChartWarnings,
  resolveAf56Accounts,
  af56Problems,
  af56Total,
  basicShare,
  findBarangayName,
  findProvinceName,
  isAf56,
  sefShare,
  ZERO_AMOUNTS,
  type Af56Detail,
  type Af56Property,
} from './af56';

const province = {
  subsidiaryType: 'PAYEE',
  subsidiaryId: 'prov',
  subsidiaryName: 'PROVINCE OF NEGROS OCCIDENTAL',
};
const brgy = (id: string, name: string) => ({
  subsidiaryType: 'PAYEE',
  subsidiaryId: id,
  subsidiaryName: name,
});

const prop = (o: Partial<Af56Property>): Af56Property => ({
  declaredOwner: 'MONSERATE, IRENEO',
  barangayId: 'b1',
  barangayName: 'Poblacion',
  basic: { ...ZERO_AMOUNTS },
  sef: { ...ZERO_AMOUNTS },
  barangaySubsidiary: brgy('pb', 'BARANGAY POBLACION'),
  ...o,
});

const detail = (properties: Af56Property[]): Af56Detail => ({
  calendarYear: '2026',
  payment: 'FULL',
  provinceSubsidiary: province,
  properties,
});

const sum = (lines: ReturnType<typeof af56Lines>, code: string, sub?: string) =>
  lines
    .filter((l) => l.accountCode === code && (sub === undefined || l.subsidiaryId === sub))
    .reduce((s, l) => s + l.amount, 0);

describe('AF 56 sharing (the office worksheet)', () => {
  it('splits the worksheet totals to the centavo', () => {
    // Basic tax prior years 4,334.58 and penalty 3,165.42.
    expect(basicShare(433458)).toEqual({ province: 151710, municipal: 173383, barangay: 108365 });
    expect(basicShare(316542)).toEqual({ province: 110790, municipal: 126617, barangay: 79135 });
    expect(sefShare(433458)).toEqual({ province: 216729, municipal: 216729 });
    expect(sefShare(316542)).toEqual({ province: 158271, municipal: 158271 });
  });

  it('turns one receipt into the lines Neil described', () => {
    // OR 880763: basic prior 2,897.60 + penalty 2,102.40; SEF the same.
    const d = detail([
      prop({
        basic: { ...ZERO_AMOUNTS, prior: 289760, penaltyPrior: 210240 },
        sef: { ...ZERO_AMOUNTS, prior: 289760, penaltyPrior: 210240 },
      }),
    ]);
    const lines = af56Lines(d);
    expect(af56Total(d)).toEqual({ basic: 500000, sef: 500000, total: 1000000 });
    expect(lines.reduce((s, l) => s + l.amount, 0)).toBe(1000000);
    // Province: 35% of basic + 50% of SEF.
    expect(sum(lines, AF56_ACCOUNTS.dueToLgus.code, 'prov')).toBe(101416 + 73584 + 144880 + 105120);
    // Barangay: 25% of basic.
    expect(sum(lines, AF56_ACCOUNTS.dueToLgus.code, 'pb')).toBe(72440 + 52560);
    expect(sum(lines, AF56_ACCOUNTS.rptBasic.code)).toBe(115904);
    expect(sum(lines, AF56_ACCOUNTS.penalties.code)).toBe(84096);
    expect(sum(lines, AF56_ACCOUNTS.dueToOtherFunds.code)).toBe(144880 + 105120);
    expect(af56LinesAgree(d, lines)).toBe(true);
    expect(
      af56LinesAgree(
        d,
        lines.map((l, i) => (i === 0 ? { ...l, amount: l.amount + 1 } : l)),
      ),
    ).toBe(false);
  });

  it('advance tax goes to Deferred RPT, and discounts are debits', () => {
    const d = detail([
      prop({
        basic: {
          ...ZERO_AMOUNTS,
          current: 100000,
          advance: 100000,
          discountCurrent: 10000,
          discountAdvance: 20000,
        },
        sef: { ...ZERO_AMOUNTS, current: 100000, discountCurrent: 10000 },
      }),
    ]);
    const lines = af56Lines(d);
    expect(sum(lines, AF56_ACCOUNTS.deferredRpt.code)).toBe(40000);
    expect(sum(lines, AF56_ACCOUNTS.rptBasicDiscount.code)).toBe(-4000);
    expect(sum(lines, AF56_ACCOUNTS.deferredRptDiscount.code)).toBe(-8000);
    // Province: 35% of (200,000 - 30,000) + 50% of 90,000.
    expect(sum(lines, AF56_ACCOUNTS.dueToLgus.code, 'prov')).toBe(59500 + 45000);
    expect(lines.reduce((s, l) => s + l.amount, 0)).toBe(af56Total(d).total);
  });

  it('two barangays on one receipt each get their own share', () => {
    const d = detail([
      prop({ basic: { ...ZERO_AMOUNTS, current: 10000 } }),
      prop({
        barangayId: 'b2',
        barangayName: 'Agboy',
        barangaySubsidiary: brgy('ag', 'BARANGAY AGBOY'),
        basic: { ...ZERO_AMOUNTS, current: 20000 },
      }),
    ]);
    const lines = af56Lines(d);
    expect(sum(lines, AF56_ACCOUNTS.dueToLgus.code, 'pb')).toBe(2500);
    expect(sum(lines, AF56_ACCOUNTS.dueToLgus.code, 'ag')).toBe(5000);
  });

  it('refuses what cannot be distributed', () => {
    expect(
      af56Problems(detail([prop({ basic: { ...ZERO_AMOUNTS, current: 100 } })]), 'SEF').join(),
    ).toMatch(/General Fund/);
    expect(
      af56Problems({
        ...detail([prop({ basic: { ...ZERO_AMOUNTS, current: 100 } })]),
        provinceSubsidiary: null,
      }).join(),
    ).toMatch(/province/);
    expect(
      af56Problems(
        detail([prop({ barangaySubsidiary: null, basic: { ...ZERO_AMOUNTS, current: 100 } })]),
      ).join(),
    ).toMatch(/Type Barangay/);
    expect(
      af56Problems(
        detail([prop({ basic: { ...ZERO_AMOUNTS, current: 100, discountCurrent: 200 } })]),
      ).join(),
    ).toMatch(/discount/);
    expect(af56Problems(detail([prop({})])).join()).toMatch(/no amount/);
    expect(
      af56Problems(detail([prop({ basic: { ...ZERO_AMOUNTS, current: 100 } })]), 'GF'),
    ).toEqual([]);
  });

  it('knows the form and finds the subsidiary Names', () => {
    expect(['AF56', 'AF 56', 'af-56', '56'].every(isAf56)).toBe(true);
    expect(isAf56('AF51')).toBe(false);
    const names = [
      { name: 'BARANGAY AGBOY', payeeType: 'BARANGAY', active: true },
      { name: 'Agboy Trading', payeeType: 'SUPPLIER', active: true },
      { name: 'PROVINCE OF NEGROS OCCIDENTAL', payeeType: 'GOVERNMENT_AGENCY', active: true },
    ];
    expect(findBarangayName('Agboy', names)?.name).toBe('BARANGAY AGBOY');
    expect(findBarangayName('Brgy. Agboy', names)?.name).toBe('BARANGAY AGBOY');
    expect(findBarangayName('Poblacion', names)).toBeNull();
    expect(findProvinceName('Negros Occidental', names)?.name).toBe(
      'PROVINCE OF NEGROS OCCIDENTAL',
    );
  });

  it('the RCD entry treats the AF 56 discount accounts as not cash', () => {
    for (const code of AF56_DISCOUNT_ACCOUNTS) expect(DISCOUNT_DEBIT_ACCOUNTS).toContain(code);
    expect(
      reportedCashDebit([
        { accountCode: '10101010', debit: 100000 },
        { accountCode: '40102041', debit: 4000 },
        { accountCode: '20501011', debit: 8000 },
        { accountCode: '20201070', debit: 0 },
      ]),
    ).toBe(100000);
  });
});

describe('the matching entry in the SEF books (patch 176)', () => {
  it('debits Due from Other Funds by exactly what the GF credited to Due to Other Funds', async () => {
    const { sefBooksEntry } = await import('./af56');
    const d = detail([
      prop({
        basic: { ...ZERO_AMOUNTS, prior: 289760, penaltyPrior: 210240 },
        sef: {
          ...ZERO_AMOUNTS,
          prior: 289760,
          current: 100000,
          advance: 50000,
          penaltyPrior: 210240,
          discountCurrent: 10000,
          discountAdvance: 5000,
        },
      }),
    ]);
    const gf = af56Lines(d)
      .filter((l) => l.accountCode === AF56_ACCOUNTS.dueToOtherFunds.code)
      .reduce((s, l) => s + l.amount, 0);
    const e = sefBooksEntry([d], 'RCD 1');
    const dr = e.reduce((s, l) => s + l.debit, 0);
    const cr = e.reduce((s, l) => s + l.credit, 0);
    expect(dr).toBe(cr);
    expect(e.find((l) => l.accountCode === '10304050')?.debit).toBe(gf);
    expect(e.find((l) => l.accountCode === '40102050')?.credit).toBe(144880 + 50000);
    expect(e.find((l) => l.accountCode === '20501020')?.credit).toBe(25000);
    expect(e.find((l) => l.accountCode === '40105020')?.credit).toBe(105120);
    expect(e.find((l) => l.accountCode === '40102051')?.debit).toBe(5000);
    expect(e.find((l) => l.accountCode === '20501021')?.debit).toBe(2500);
    expect(sefBooksEntry([])).toEqual([]);
  });
});

describe("patch 179: the municipal share on the chart's Real Property Tax account", () => {
  const d = detail([prop({ basic: { ...ZERO_AMOUNTS, current: 2_000_00 } })]);

  it('keeps 40102040 when the chart calls it Real Property Tax - Basic', () => {
    const acc = resolveAf56Accounts([{ code: '40102040', name: 'Real Property Tax- Basic' }]);
    expect(acc.rptBasic.code).toBe('40102040');
    expect(af56ChartWarnings([{ code: '40102040', name: 'Real Property Tax- Basic' }])).toEqual([]);
  });

  it('finds the RPT account by name when 40102040 is something else', () => {
    const chart = [
      { code: '40102040', name: 'Franchise Tax' },
      { code: '40101010', name: 'Real Property Tax - Basic' },
      { code: '40101011', name: 'Discount on Real Property Tax - Basic' },
    ];
    const acc = resolveAf56Accounts(chart);
    expect(acc.rptBasic.code).toBe('40101010');
    expect(acc.rptBasicDiscount.code).toBe('40101011');
    const lines = af56Lines(d, acc);
    expect(sum(lines, '40101010')).toBe(800_00);
    expect(sum(lines, '40102040')).toBe(0);
    // A receipt saved either way agrees.
    expect(af56LinesAgree(d, lines, acc)).toBe(true);
    expect(af56LinesAgree(d, af56Lines(d), acc)).toBe(true);
  });

  it('warns when no Real Property Tax account exists and 40102040 is mislabelled', () => {
    const w = af56ChartWarnings([{ code: '40102040', name: 'Franchise Tax' }]);
    expect(w[0]).toMatch(/calls 40102040 "Franchise Tax"/);
  });
});
