import { describe, expect, it } from 'vitest';
import { ZERO_AMOUNTS, af56Lines, type Af56Detail } from '@/lib/af56';
import { buildAf56Abstract, type Af56Receipt } from './af56AbstractReport';

const sub = { subsidiaryType: 'PAYEE', subsidiaryId: 'x', subsidiaryName: 'X' };
const receipt = (
  orNumber: string,
  orDate: string,
  owner: string,
  prior: number,
  penalty: number,
  period: string,
): Af56Receipt => {
  const amounts = { ...ZERO_AMOUNTS, prior, penaltyPrior: penalty };
  const rpt: Af56Detail = {
    calendarYear: '2026',
    payment: 'FULL',
    provinceSubsidiary: sub,
    properties: [
      {
        declaredOwner: owner,
        barangayId: 'b',
        barangayName: 'Poblacion',
        period,
        basic: amounts,
        sef: amounts,
        barangaySubsidiary: { ...sub, subsidiaryId: 'pob' },
      },
    ],
  };
  return { orNumber, orDate, payorName: owner, rpt, status: 'ISSUED' };
};

// The three receipts on the office's worksheet.
const receipts = [
  receipt('880763', '2026-09-24', 'MONSERATE, IRENEO', 289760, 210240, '2012(1-3)'),
  receipt('880851', '2026-09-30', 'MESIAS, RODOLFO JR.', 54270, 39076, '2009(1-4)'),
  receipt('880852', '2026-09-30', 'MESIAS, RODOLFO JR.', 89428, 67226, '2015(1)'),
];

describe('the AF 56 abstract', () => {
  const a = buildAf56Abstract({ receipts, fromDate: '2026-09-01', toDate: '2026-09-30' });

  it('lists one row per receipt with the worksheet totals', () => {
    expect(a.rows.map((r) => r.orNumber)).toEqual(['880763', '880851', '880852']);
    expect(a.rows[0].basic.total).toBe(500000);
    expect(a.totals.basic.prior).toBe(433458);
    expect(a.totals.basic.penalty).toBe(316542);
    expect(a.totals.basic.total).toBe(750000);
    expect(a.totals.total).toBe(1500000);
  });

  it('shares add back to the collection and match what the receipts recorded', () => {
    const b = a.summary.basic.total;
    expect(b.total).toBe(750000);
    expect(b.province + b.municipal + b.barangay).toBe(750000);
    const s = a.summary.sef.total;
    expect(s.province + s.municipal).toBe(750000);
    expect(s.province).toBe(375000);
    // Province share on the abstract = the receipts' Due to LGUs (province) lines.
    const recorded = receipts
      .flatMap((r) => af56Lines(r.rpt!))
      .filter((l) => l.accountCode === '20201070' && l.subsidiaryId === 'x')
      .reduce((t, l) => t + l.amount, 0);
    expect(recorded).toBe(b.province + s.province);
    expect(a.byBarangay).toEqual([{ barangayName: 'Poblacion', share: b.barangay }]);
  });
});
