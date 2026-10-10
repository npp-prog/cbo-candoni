import { describe, expect, it } from 'vitest';
import { holdsSerial, officerHoldings } from './formCustody';

const mv = (kind: string, from: string, to: string, date: string, who: Record<string, string>) => ({
  formCode: 'AF-51',
  kind,
  movementDate: date,
  serialFrom: from,
  serialTo: to,
  ...who,
});

describe('officerHoldings (patch 161)', () => {
  const ledger = [
    mv('RECEIPT', '1000001', '1000100', '2026-10-01', {}),
    mv('ISSUE', '1000001', '1000050', '2026-10-02', { custodianId: 'e1' }),
    mv('ISSUE', '1000051', '1000100', '2026-10-02', { custodianId: 'e2' }),
    mv('RETURN', '1000041', '1000050', '2026-10-09', { fromCustodianId: 'e1' }),
  ];

  it('holds what was issued to the officer, by form code however written', () => {
    const held = officerHoldings(ledger, 'e1', 'AF51', '2026-10-05');
    expect(holdsSerial(held, '1000001')).toBe(true);
    expect(holdsSerial(held, '1000050')).toBe(true);
    expect(holdsSerial(held, '1000051')).toBe(false);
  });

  it('not before it was issued, and not after it was returned', () => {
    expect(holdsSerial(officerHoldings(ledger, 'e1', 'AF51', '2026-10-01'), '1000001')).toBe(false);
    const after = officerHoldings(ledger, 'e1', 'AF51', '2026-10-10');
    expect(holdsSerial(after, '1000045')).toBe(false);
    expect(holdsSerial(after, '1000040')).toBe(true);
  });

  it('ignores a voided movement and another form', () => {
    const held = officerHoldings(
      [
        { ...ledger[1], voided: true },
        { ...ledger[1], formCode: 'AF56' },
      ],
      'e1',
      'AF51',
      '2026-10-05',
    );
    expect(held).toEqual([]);
  });
});
