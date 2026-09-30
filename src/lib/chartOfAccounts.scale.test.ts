import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkChart, deriveAccount, isContraAccount } from './chartOfAccounts';

/**
 * The derivation run over the municipality's whole chart.
 *
 * The unit tests above check a rule against the codes it was written for,
 * which is exactly the shape of test that passes while a rule is wrong about
 * a hundred accounts nobody looked at. This one runs every rule over all six
 * hundred and twenty-five and asserts the totals.
 *
 * `data/chart-of-accounts.csv` is the municipality's own file, shipped so the
 * first load is an upload rather than a week of typing - and so this test has
 * something real to run against.
 */

interface Row {
  lineNo: number;
  code: string;
  name: string;
}

/** A small CSV reader: two columns, the second possibly quoted. */
function parse(text: string): Row[] {
  return text
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map((line, i) => {
      const match = line.match(/^([^,]+),(.*)$/);
      if (!match) return null;
      let name = match[2];
      if (name.startsWith('"') && name.endsWith('"')) {
        name = name.slice(1, -1).replace(/""/g, '"');
      }
      return { lineNo: i + 1, code: match[1], name };
    })
    .filter((r): r is Row => r !== null);
}

describe('the municipality chart of accounts', () => {
  const rows = parse(readFileSync('data/chart-of-accounts.csv', 'utf8'));
  const derived = rows.map((r) => deriveAccount(r));

  it('is the 625 accounts COA publishes', () => {
    expect(rows).toHaveLength(625);
  });

  it('passes the file check with no duplicate and no malformed code', () => {
    expect(checkChart(rows).violations).toEqual([]);
  });

  /**
   * The assertion that matters. An account CBO cannot classify is one the
   * loader would refuse, and finding that out during the first upload rather
   * than here would be finding it out in front of the Accountant.
   */
  it('classifies every single account', () => {
    const unclassified = rows.filter((_, i) => derived[i] === null).map((r) => r.code);
    expect(unclassified).toEqual([]);
  });

  it('splits into the five account groups the file itself carries', () => {
    const byClass = derived.reduce<Record<string, number>>((m, a) => {
      m[a!.accountClass] = (m[a!.accountClass] ?? 0) + 1;
      return m;
    }, {});
    expect(byClass).toEqual({
      ASSET: 305,
      LIABILITY: 44,
      EQUITY: 32,
      REVENUE: 96,
      EXPENSE: 148,
    });
  });

  /**
   * A hundred and forty-five contra accounts, and every one of them must move
   * against its class. This is the single largest thing the derivation does
   * that a hand-classified chart gets wrong.
   */
  it('turns all 145 contra accounts around', () => {
    const contra = rows.filter((r) => isContraAccount(r.name));
    expect(contra).toHaveLength(145);

    const wrongWay = contra.filter((r) => {
      const a = deriveAccount(r)!;
      const ordinary = a.accountClass === 'ASSET' || a.accountClass === 'EXPENSE';
      return a.normalBalance === (ordinary ? 'DEBIT' : 'CREDIT');
    });
    expect(wrongWay).toEqual([]);
  });

  it('leaves no contra account chargeable to the budget', () => {
    const chargeableContra = derived.filter(
      (a) => a!.expenseClass !== null && isContraAccount(a!.name),
    );
    expect(chargeableContra).toEqual([]);
  });

  /**
   * Sixty-nine assets a Capital Outlay appropriation can be charged to, and
   * not one expense account among them - which is the whole finding: before
   * this, CBO offered only expense accounts and a Capital Outlay obligation
   * could not be encoded at all.
   */
  it('finds 69 things Capital Outlay can buy, all of them assets', () => {
    const co = derived.filter((a) => a!.expenseClass === 'CO');
    expect(co).toHaveLength(69);
    expect(co.every((a) => a!.accountClass === 'ASSET')).toBe(true);
  });

  it('classes the expense accounts the appropriation ordinance uses', () => {
    const byExpenseClass = derived.reduce<Record<string, number>>((m, a) => {
      const k = a!.expenseClass ?? 'none';
      m[k] = (m[k] ?? 0) + 1;
      return m;
    }, {});
    expect(byExpenseClass.PS).toBe(28);
    expect(byExpenseClass.MOOE).toBe(80);
    expect(byExpenseClass.FE).toBe(6);
    expect(byExpenseClass.CO).toBe(69);
  });

  it('holds back the 25 registry accounts from the General Ledger', () => {
    const notPostable = derived.filter((a) => !a!.postable);
    expect(notPostable).toHaveLength(25);
    expect(notPostable.every((a) => a!.code.startsWith('305'))).toBe(true);
  });

  it('requires a subsidiary on only the six CBO itself chases', () => {
    const subsidiary = derived.filter((a) => a!.requiresSubsidiary).map((a) => a!.code);
    expect(subsidiary.sort()).toEqual([
      '10301010',
      '10305010',
      '10305020',
      '10305030',
      '10305040',
      '20101010',
    ]);
  });
});
