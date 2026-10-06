import { useMemo, useState } from 'react';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, DateInput, Select } from '@/components/ui/Field';
import { useFilters } from '@/context/FilterContext';
import { useLedgerEntries, useAccounts } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { formatLongDate } from '@/lib/dates';
import { todayPh } from '@/lib/dates';
import { fundLabel } from '../budget/Obligations';
import type { LedgerEntry } from '@/types/accounting';
import type { Centavos } from '@/types/common';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { ACCOUNTING_MONITORING_TABS } from '@/layout/sections';

/**
 * Aging of receivables and payables.
 *
 * Built from posted ledger entries, never from a separate ledger of open
 * items. That is the harder way to do it and the only way that cannot drift:
 * an aging report kept in its own table eventually disagrees with the balance
 * sheet, and the first anyone knows of it is when an auditor foots both.
 *
 * How an age is arrived at. For each account and each party - a payee, a
 * customer, an employee - the entries are taken in date order and settled
 * oldest-first. A credit against a payable account is a payment, and it clears
 * the oldest unpaid debit before the next. What remains unsettled at the end is
 * the outstanding balance, and each remaining piece keeps the date of the entry
 * that created it. That is what puts it in a bucket.
 *
 * Oldest-first is an assumption, and it is stated rather than hidden: without
 * an invoice reference on every payment, no system can know which particular
 * invoice a payment settled. Oldest-first is the convention COA expects and is
 * the conservative choice, since it ages the remaining balance no younger than
 * the truth.
 *
 * Buckets are the standard four, counted from the entry date to the as-at date:
 * current (not yet 30 days), 31-60, 61-90, over 90.
 */

interface Bucket {
  current: Centavos;
  d31: Centavos;
  d61: Centavos;
  over90: Centavos;
  total: Centavos;
  oldestDate?: string;
}

interface PartyRow extends Bucket {
  partyId: string;
  partyName: string;
}

interface AccountGroup extends Bucket {
  accountCode: string;
  accountName: string;
  parties: PartyRow[];
}

const EMPTY: Bucket = { current: 0, d31: 0, d61: 0, over90: 0, total: 0 };

function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`);
  const b = new Date(`${to}T00:00:00`);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/**
 * The date an item is aged from.
 *
 * Normally the date of the entry that recorded it. Opening balances are the
 * exception: a payable carried forward from the previous system is posted on
 * the day the books were converted, but it has been outstanding since the
 * voucher was approved. Ageing it from the conversion date would show every
 * carried-forward supplier as current on the first day, and the report would be
 * at its least useful exactly when the office most needs it.
 */
function ageDate(entry: LedgerEntry): string {
  return entry.agingDate ?? entry.entryDate;
}

function addToBucket(bucket: Bucket, date: string, asOf: string, amount: Centavos): void {
  const age = daysBetween(date, asOf);
  if (age <= 30) bucket.current += amount;
  else if (age <= 60) bucket.d31 += amount;
  else if (age <= 90) bucket.d61 += amount;
  else bucket.over90 += amount;
  bucket.total += amount;
  if (!bucket.oldestDate || date < bucket.oldestDate) bucket.oldestDate = date;
}

/**
 * Settles a party's entries oldest-first and returns what is left outstanding,
 * each piece still carrying the date it arose on.
 *
 * `sign` is +1 for a receivable (a debit increases what is owed to the
 * municipality) and -1 for a payable (a credit increases what the municipality
 * owes). Working in one signed direction keeps a single routine correct for
 * both sides of the balance sheet.
 */
function outstandingPieces(
  entries: LedgerEntry[],
  sign: 1 | -1,
): Array<{ date: string; amount: Centavos }> {
  const open: Array<{ date: string; amount: Centavos }> = [];
  let settlement = 0;

  for (const entry of [...entries].sort((a, b) => ageDate(a).localeCompare(ageDate(b)))) {
    const movement = entry.signedAmount * sign;
    if (movement > 0) {
      open.push({ date: ageDate(entry), amount: movement });
    } else {
      settlement += -movement;
    }

    // Apply whatever settlement has accumulated against the oldest open pieces.
    while (settlement > 0 && open.length) {
      if (open[0].amount > settlement) {
        open[0].amount -= settlement;
        settlement = 0;
      } else {
        settlement -= open[0].amount;
        open.shift();
      }
    }
  }

  return open;
}

export default function Aging() {
  const { fiscalYear, fundCode } = useFilters();
  const [asOf, setAsOf] = useState(todayPh());
  const [side, setSide] = useState<'PAYABLE' | 'RECEIVABLE'>('PAYABLE');
  /*
   * One control account, or all of them.
   *
   * The report is a stack of accounts, each with its parties under it, and on
   * a full year that is pages. Somebody chasing what is owed to one supplier
   * is in one account and reads past the rest to find it.
   *
   * Cleared whenever the side changes, because a payable account has no
   * meaning on the receivable report and a filter the reader cannot see the
   * effect of is worse than none.
   */
  const [accountCode, setAccountCode] = useState('');

  const accounts = useAccounts(false);
  const ledger = useLedgerEntries(fiscalYear, fundCode);

  /**
   * Which accounts belong on this report. Receivables are current and
   * non-current assets whose name marks them as amounts owed to the
   * municipality; payables are the liability accounts. Taken from the chart of
   * accounts' own classification rather than a hard-coded list of codes, so a
   * new payable account added by the Accountant appears here without a code
   * change.
   */
  const relevantAccounts = useMemo(() => {
    const isReceivable = (fs?: string, name?: string) =>
      (fs === 'CURRENT_ASSET' || fs === 'NON_CURRENT_ASSET') &&
      /receivable|due from/i.test(name ?? '');
    const isPayable = (fs?: string) => fs === 'CURRENT_LIABILITY' || fs === 'NON_CURRENT_LIABILITY';

    return accounts.data.filter((a) =>
      side === 'RECEIVABLE'
        ? isReceivable(a.fsClassification, a.name)
        : isPayable(a.fsClassification),
    );
  }, [accounts.data, side]);

  const groups = useMemo<AccountGroup[]>(() => {
    const chosen = accountCode
      ? relevantAccounts.filter((a) => a.code === accountCode)
      : relevantAccounts;
    const codes = new Set(chosen.map((a) => a.code));
    const sign: 1 | -1 = side === 'RECEIVABLE' ? 1 : -1;

    // account -> party -> entries
    const byAccount = new Map<string, Map<string, { name: string; entries: LedgerEntry[] }>>();

    for (const entry of ledger.data) {
      if (!codes.has(entry.accountCode)) continue;
      if (ageDate(entry) > asOf) continue;

      const partyId = entry.subsidiaryId ?? entry.payeeId ?? '__unidentified__';
      const partyName =
        entry.subsidiaryName ?? entry.payeeName ?? 'Not attributed to a party';

      let parties = byAccount.get(entry.accountCode);
      if (!parties) {
        parties = new Map();
        byAccount.set(entry.accountCode, parties);
      }
      const party = parties.get(partyId);
      if (party) party.entries.push(entry);
      else parties.set(partyId, { name: partyName, entries: [entry] });
    }

    const result: AccountGroup[] = [];

    for (const account of relevantAccounts) {
      const parties = byAccount.get(account.code);
      if (!parties) continue;

      const partyRows: PartyRow[] = [];
      const accountTotals: Bucket = { ...EMPTY };

      for (const [partyId, party] of parties) {
        const pieces = outstandingPieces(party.entries, sign);
        if (!pieces.length) continue;

        const bucket: Bucket = { ...EMPTY };
        for (const piece of pieces) addToBucket(bucket, piece.date, asOf, piece.amount);

        partyRows.push({ partyId, partyName: party.name, ...bucket });

        accountTotals.current += bucket.current;
        accountTotals.d31 += bucket.d31;
        accountTotals.d61 += bucket.d61;
        accountTotals.over90 += bucket.over90;
        accountTotals.total += bucket.total;
        if (
          bucket.oldestDate &&
          (!accountTotals.oldestDate || bucket.oldestDate < accountTotals.oldestDate)
        ) {
          accountTotals.oldestDate = bucket.oldestDate;
        }
      }

      if (!partyRows.length) continue;

      partyRows.sort((a, b) => b.total - a.total);
      result.push({
        accountCode: account.code,
        accountName: account.name,
        parties: partyRows,
        ...accountTotals,
      });
    }

    return result.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  }, [ledger.data, relevantAccounts, accountCode, asOf, side]);

  const grand = useMemo(
    () =>
      groups.reduce<Bucket>(
        (acc, g) => ({
          current: acc.current + g.current,
          d31: acc.d31 + g.d31,
          d61: acc.d61 + g.d61,
          over90: acc.over90 + g.over90,
          total: acc.total + g.total,
        }),
        { ...EMPTY },
      ),
    [groups],
  );

  const title = side === 'RECEIVABLE' ? 'Aging of Receivables' : 'Aging of Payables';

  return (
    <>
      <PageHeader
        title={title}
        breadcrumbs={[{ label: 'Reports' }, { label: 'Aging' }]}
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}. Computed from posted ledger entries, settled oldest first.`}
        actions={
          <Button variant="secondary" onClick={() => window.print()}>
            Print
          </Button>
        }
      />

      <SectionTabs tabs={ACCOUNTING_MONITORING_TABS} />

      <Card className="no-print">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Report">
            <Select
              value={side}
              onChange={(e) => {
                setSide(e.target.value as 'PAYABLE' | 'RECEIVABLE');
                // A payable account means nothing on the receivable report.
                setAccountCode('');
              }}
            >
              <option value="PAYABLE">Payables - what the municipality owes</option>
              <option value="RECEIVABLE">Receivables - what is owed to the municipality</option>
            </Select>
          </Field>
          <Field label="As at" hint="Ages are counted from the entry date to this date.">
            <DateInput value={asOf} onChange={setAsOf} />
          </Field>

          <Field
            label="Account"
            hint="One control account, or every account on this side."
            className="sm:col-span-2"
          >
            <Select value={accountCode} onChange={(e) => setAccountCode(e.target.value)}>
              <option value="">
                All {side === 'RECEIVABLE' ? 'receivable' : 'payable'} accounts
              </option>
              {relevantAccounts.map((a) => (
                <option key={a.code} value={a.code}>
                  {a.code} - {a.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      <Card className="mt-4">
        {ledger.loading || accounts.loading ? (
          <p className="py-8 text-center text-sm text-slate-500">Loading…</p>
        ) : ledger.error ? (
          <Alert tone="error">{ledger.error}</Alert>
        ) : groups.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">
            Nothing outstanding as at {formatLongDate(asOf)}
            {accountCode
              ? ` on ${accountCode}. Choose "All ${side === 'RECEIVABLE' ? 'receivable' : 'payable'} accounts" to see the rest.`
              : '.'}
          </p>
        ) : (
          <div>
            <div className="mb-5 text-center">
              <h2 className="text-base font-semibold uppercase text-navy-900">{title}</h2>
              <p className="text-sm text-slate-600">
                Municipal Government of Candoni, Province of Negros Occidental
              </p>
              <p className="text-sm text-slate-600">
                {fundLabel(fundCode)} · as at {formatLongDate(asOf)}
              </p>
            </div>

            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-y border-slate-300 bg-slate-50 text-xs uppercase text-slate-600">
                  <th className="px-2 py-2 text-left">Account / party</th>
                  <th className="px-2 py-2 text-right">Not yet due (≤30)</th>
                  <th className="px-2 py-2 text-right">31 - 60</th>
                  <th className="px-2 py-2 text-right">61 - 90</th>
                  <th className="px-2 py-2 text-right">Over 90</th>
                  <th className="px-2 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <>
                    <tr key={group.accountCode} className="border-t border-slate-200 bg-slate-50/60">
                      <td className="px-2 py-1.5 font-semibold text-navy-900">
                        <span className="font-mono text-xs text-slate-600">{group.accountCode}</span>{' '}
                        {group.accountName}
                      </td>
                      <td className="px-2 py-1.5 text-right font-semibold">
                        <span className="cbo-amount">{formatPeso(group.current)}</span>
                      </td>
                      <td className="px-2 py-1.5 text-right font-semibold">
                        <span className="cbo-amount">{formatPeso(group.d31)}</span>
                      </td>
                      <td className="px-2 py-1.5 text-right font-semibold">
                        <span className="cbo-amount">{formatPeso(group.d61)}</span>
                      </td>
                      <td className="px-2 py-1.5 text-right font-semibold">
                        <span className="cbo-amount">{formatPeso(group.over90)}</span>
                      </td>
                      <td className="px-2 py-1.5 text-right font-semibold">
                        <span className="cbo-amount">{formatPeso(group.total)}</span>
                      </td>
                    </tr>
                    {group.parties.map((party) => (
                      <tr
                        key={`${group.accountCode}-${party.partyId}`}
                        className="border-b border-slate-100"
                      >
                        <td className="px-2 py-1.5 pl-8 text-slate-700">
                          {party.partyName}
                          {party.oldestDate && (
                            <span className="ml-2 text-xs text-slate-400">
                              oldest {formatLongDate(party.oldestDate)}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <span className="cbo-amount">{formatPeso(party.current)}</span>
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <span className="cbo-amount">{formatPeso(party.d31)}</span>
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <span className="cbo-amount">{formatPeso(party.d61)}</span>
                        </td>
                        <td
                          className={`px-2 py-1.5 text-right ${party.over90 > 0 ? 'text-amber-800' : ''}`}
                        >
                          <span className="cbo-amount">{formatPeso(party.over90)}</span>
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <span className="cbo-amount">{formatPeso(party.total)}</span>
                        </td>
                      </tr>
                    ))}
                  </>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-400 font-semibold">
                  <td className="px-2 py-2">Total</td>
                  <td className="px-2 py-2 text-right">
                    <span className="cbo-amount">{formatPeso(grand.current)}</span>
                  </td>
                  <td className="px-2 py-2 text-right">
                    <span className="cbo-amount">{formatPeso(grand.d31)}</span>
                  </td>
                  <td className="px-2 py-2 text-right">
                    <span className="cbo-amount">{formatPeso(grand.d61)}</span>
                  </td>
                  <td className="px-2 py-2 text-right">
                    <span className="cbo-amount">{formatPeso(grand.over90)}</span>
                  </td>
                  <td className="px-2 py-2 text-right">
                    <span className="cbo-amount">{formatPeso(grand.total)}</span>
                  </td>
                </tr>
              </tfoot>
            </table>

            <p className="mt-4 text-xs text-slate-500">
              Settlements are applied to the oldest outstanding amount first. Without an invoice
              reference on each payment no system can know which particular item a payment settled;
              oldest-first is the convention COA expects and never reports a balance as younger than
              it is. Entries not attributed to a party are grouped under “Not attributed to a
              party” — attach a payee or subsidiary to those journal lines to age them by counterparty.
            </p>
          </div>
        )}
      </Card>
    </>
  );
}
