import { useMemo } from 'react';
import { useAccounts, useCashAdvances, useLedgerEntries } from '@/data/queries';
import { buildAdvanceRegister } from '@/lib/advances';
import { isLiquidatableAccount, liquidatableByDefault } from '@/lib/chartOfAccounts';
import type { CashAdvance } from '@/types/accounting';

/**
 * The cash advances of a year and fund, as the liquidation report and the
 * Cash Advance Summary see them. Patch 133.
 *
 * Read off the General Ledger: every debit to an account the Chart of Accounts
 * marks "Advance subject to liquidation", with the officer as its subsidiary
 * (src/lib/advances.ts). Any record in the old `cashAdvances` collection is
 * included as well, so nothing that was there disappears.
 */
export function useAdvances(fiscalYear: number, fundCode: string, outstandingOnly = true) {
  const ledger = useLedgerEntries(fiscalYear, fundCode);
  const accounts = useAccounts(false);
  const legacy = useCashAdvances(fiscalYear, outstandingOnly);

  const isAdvance = useMemo(() => {
    const byCode = new Map(accounts.data.map((a) => [String(a.code).trim(), a]));
    return (code: string) => {
      const a = byCode.get(code);
      return a ? isLiquidatableAccount(a) : liquidatableByDefault(code, '');
    };
  }, [accounts.data]);

  const register = useMemo(
    () =>
      buildAdvanceRegister(
        ledger.data.map((e) => ({
          id: e.id,
          fiscalYear: e.fiscalYear,
          fundCode: e.fundCode,
          entryDate: e.entryDate,
          agingDate: e.agingDate ?? null,
          jevNo: e.jevNo,
          referenceNo: e.referenceNo ?? null,
          accountCode: e.accountCode,
          accountName: e.accountName,
          debit: e.debit,
          credit: e.credit,
          subsidiaryType: e.subsidiaryType ?? null,
          subsidiaryId: e.subsidiaryId ?? null,
          subsidiaryName: e.subsidiaryName ?? null,
          officeId: e.officeId ?? null,
          officeName: e.officeName ?? null,
          particulars: e.particulars ?? null,
        })),
        isAdvance,
      ),
    [ledger.data, isAdvance],
  );

  const data = useMemo<CashAdvance[]>(() => {
    const fromLedger: CashAdvance[] = register.advances
      .filter((a) => !outstandingOnly || a.outstanding > 0)
      .map((a) => ({
        id: a.id,
        fiscalYear: a.fiscalYear,
        fundCode: a.fundCode,
        caType: 'OTHER',
        dvId: '',
        dvNo: a.reference,
        accountableOfficerId: a.officerId ?? a.officerName,
        accountableOfficerName: a.officerName,
        officeId: a.officeId ?? '',
        officeName: a.officeName,
        dateGranted: a.dateGranted,
        amountGranted: a.amountGranted,
        purpose: a.purpose,
        dueDate: '',
        amountLiquidated: a.amountSettled,
        amountRefunded: 0,
        outstandingBalance: a.outstanding,
        status:
          a.outstanding <= 0
            ? 'FULLY_LIQUIDATED'
            : a.amountSettled > 0
              ? 'PARTIALLY_LIQUIDATED'
              : 'OUTSTANDING',
        glAccountCode: a.accountCode,
        glAccountName: a.accountName,
        subsidiaryType: a.subsidiaryType,
        jevNo: a.jevNo,
        source: 'LEDGER',
      }));
    return [...legacy.data.filter((c) => c.fundCode === fundCode), ...fromLedger];
  }, [register.advances, legacy.data, outstandingOnly, fundCode]);

  return {
    data,
    unassigned: register.unassigned,
    loading: ledger.loading || accounts.loading || legacy.loading,
    error: ledger.error ?? accounts.error ?? legacy.error,
  };
}
