import { describe, expect, it } from 'vitest';
import { clearingObjection } from './clearing';

describe('payees the clearing house refuses', () => {
  it('refuses a check payable to CASH', () => {
    expect(clearingObjection('CASH')?.found).toBe('CASH');
    expect(clearingObjection('cash')?.found).toBe('CASH');
    expect(clearingObjection('PAY TO CASH')?.found).toBe('CASH');
  });

  it('refuses a payee naming one party and/or another', () => {
    expect(clearingObjection('JUAN DELA CRUZ AND/OR MARIA SANTOS')?.found).toBe('and/or');
    expect(clearingObjection('juan and/or maria')?.found).toBe('and/or');
  });

  it('leaves alone a real payee whose name contains the word', () => {
    // These are the false positives that would teach people to click through
    // the warning, which is worse than not having one. All three are names a
    // municipality genuinely draws checks to.
    expect(clearingObjection('CASHIER OF THE MUNICIPALITY')).toBeNull();
    expect(clearingObjection('CASH & CARRY TRADING')).toBeNull();
    expect(clearingObjection('ENCASHMENT SERVICES INC')).toBeNull();
    expect(clearingObjection('PETTY CASH FUND')).toBeNull();
    expect(clearingObjection('PETTY CASH CUSTODIAN')).toBeNull();
  });

  it('sees through the words a teller writes around the payee', () => {
    expect(clearingObjection('Pay to the order of CASH')?.found).toBe('CASH');
    expect(clearingObjection('  cash  ')?.found).toBe('CASH');
  });

  it('passes an ordinary payee', () => {
    expect(clearingObjection('SUNTECH TRADING & MARKETING')).toBeNull();
    expect(clearingObjection('DELA CRUZ, Juan M.')).toBeNull();
  });

  it('says nothing about an empty name, which is a different complaint', () => {
    expect(clearingObjection('')).toBeNull();
    expect(clearingObjection(null)).toBeNull();
    expect(clearingObjection(undefined)).toBeNull();
  });

  it('explains what to do rather than only refusing', () => {
    expect(clearingObjection('CASH')?.message).toContain('the person or supplier being paid');
    expect(clearingObjection('A AND/OR B')?.message).toContain('single payee');
  });
});
