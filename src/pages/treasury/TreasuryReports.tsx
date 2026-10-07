import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { proposePaymentEntry } from '@/lib/treasuryEntry';
import { newestFirst } from '@/lib/registerOrder';
import {
  cashInBankLine,
  ACCOUNTS_PAYABLE,
  ADVANCES_FOR_PAYROLL,
  CASH_LOCAL_TREASURY,
  DUE_TO_OFFICERS_AND_EMPLOYEES,
} from '@/lib/chartOfAccounts';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Field, DateInput, TextInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { BankAccountPicker, EmployeePicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import {
  useTreasuryReports,
  useChecks,
  useAda,
  useCollections,
  usePayrolls,
  useAccounts,
  useBankAccounts,
} from '@/data/queries';
import { createDraft, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { formatPeso } from '@/lib/money';
import { formatShortDate, todayPh } from '@/lib/dates';
import {
  TREASURY_REPORT_LABELS,
  TREASURY_REPORT_SHORT,
  isECollectionReport,
  type TreasuryReportType,
} from '@/types/enums';
import type { TreasuryReport, TreasuryReportLine } from '@/types/treasury';
import { fundLabel } from '../budget/Obligations';
import { SECTION_TABS } from './sections';
import { kindForReport } from './eCollectionKinds';

/**
 * Treasury reports: RCI, RADAI, RCD and RCDisb.
 *
 * One screen for all four, because they are one document with four contents.
 * The Treasurer's office selects the documents it prepared, the report is
 * certified, and it goes to Accounting to be journalized. Nothing here writes
 * to the General Ledger; nothing here can.
 *
 * Two things the screen is careful about.
 *
 * Only unreported documents are offered for selection. A check already covered
 * by a certified RCI does not appear in the picker, because reporting a
 * disbursement twice is how the same payment reaches the ledger twice. The
 * engine refuses it as well - this is the convenience, not the control.
 *
 * The proposed entry is built here and shown before certifying, so the
 * Treasurer can see what the report will ask Accounting to book. But the
 * Accountant is the one who may change it: this screen has no way to post.
 */

interface SourceDoc {
  id: string;
  sourceNo: string;
  date: string;
  /** Carried onto the report line so the entry can name the creditor. */
  payeeId?: string;
  payeeName?: string;
  particulars?: string;
  /** What the report reports: the face amount, or a payroll's net. */
  amount: number;
  /** RCDisb only - the payroll figures behind the net, shown but not posted. */
  gross?: number;
  deductions?: number;
  treasuryReportId?: string;
  status?: string;
}

/**
 * Cash and payable accounts, taken from the single checked list in
 * lib/chartOfAccounts rather than written out again here. Two of the four
 * written out here before were not the accounts their titles named.
 */
const ACCOUNTS = {
  accountsPayable: ACCOUNTS_PAYABLE,
  cashLocalTreasury: CASH_LOCAL_TREASURY,
  dueToOfficersAndEmployees: DUE_TO_OFFICERS_AND_EMPLOYEES,
  advancesForPayroll: ADVANCES_FOR_PAYROLL,
};

/**
 * The tabs shown above each report - the report and the register it summarises,
 * side by side, so the Treasurer can move between the checks and the RCI of
 * those checks without going back to the sidebar.
 */

export default function TreasuryReports({
  reportType,
  aside,
}: {
  reportType: TreasuryReportType;
  /**
   * Rendered under the tab strip. The e-collection registers use it to carry
   * the choice between Annexes E, F and G - three COA reports that are one
   * piece of work to the officer preparing them, so they share a tab rather
   * than taking three.
   */
  aside?: ReactNode;
}) {
  const { fiscalYear, fundCode } = useFilters();
  const { can, user, profile } = useAuth();
  const navigate = useNavigate();

  const label = TREASURY_REPORT_LABELS[reportType];
  const short = TREASURY_REPORT_SHORT[reportType];

  const { data, loading, error } = useTreasuryReports(reportType, fiscalYear, fundCode);

  const rows = useMemo(
    () => newestFirst(data, (r) => ({ ref: r.reportNo, date: r.reportDate })),
    [data],
  );

  const [showForm, setShowForm] = useState(false);

  const canPrepare = can('treasury', 'create');

  const actor =
    user
      ? actorStamp({
          uid: user.uid,
          name: profile?.displayName ?? user.email ?? user.uid,
          position: profile?.position,
        })
      : null;

  const columns: Column<TreasuryReport>[] = [
    {
      key: 'reportNo',
      header: `${short} No.`,
      width: '11rem',
      value: (r) => r.reportNo ?? '',
      cell: (r) =>
        r.reportNo ? (
          <span className="font-mono text-xs">{r.reportNo}</span>
        ) : (
          <span className="text-xs italic text-slate-400">Draft</span>
        ),
    },
    {
      key: 'reportDate',
      header: 'Date',
      width: '8rem',
      value: (r) => r.reportDate,
      cell: (r) => <span className="text-sm">{formatShortDate(r.reportDate)}</span>,
    },
    {
      key: 'coverage',
      header: 'Covering',
      value: (r) => r.serialFrom ?? '',
      cell: (r) => (
        <span className="text-sm">
          {r.lines.length} document{r.lines.length === 1 ? '' : 's'}
          {r.serialFrom ? (
            <span className="ml-2 font-mono text-xs text-slate-500">
              {r.serialFrom}
              {r.serialTo && r.serialTo !== r.serialFrom ? ` - ${r.serialTo}` : ''}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'totalAmount',
      header: reportType === 'RCDISB' ? 'Net paid' : 'Total',
      width: '11rem',
      align: 'right',
      value: (r) => r.totalAmount,
      cell: (r) => <span className="cbo-amount block">{formatPeso(r.totalAmount)}</span>,
    },
    {
      key: 'jevNo',
      header: 'JEV',
      width: '10rem',
      value: (r) => r.jevNo ?? '',
      cell: (r) =>
        r.jevNo ? (
          <span className="font-mono text-xs">{r.jevNo}</span>
        ) : (
          <span className="text-xs text-slate-400">-</span>
        ),
    },
    {
      key: 'status',
      header: '',
      width: '15rem',
      sortable: false,
      fixed: true,
      value: (r) => r.status,
      cell: (r) => (
        /*
          Certify and Withdraw used to be buttons here. They are on the
          report's own page now, beside the documents it covers, the entry it
          proposes and the signed form attached to it - which are the things a
          Treasurer should have read before certifying. A button on a row
          certifies a report nobody has opened.
        */
        <div className="flex items-center justify-end gap-1.5">
          <StatusBadge status={r.status} />
          <Button size="sm" variant="ghost" onClick={() => navigate(`/treasury/reports/${r.id}`)}>
            Open
          </Button>
        </div>
      ),
    },
  ];



  return (
    <>
      <PageHeader
        title={label}
        breadcrumbs={[{ label: 'Treasury' }, { label: short }]}
        subtitle={
          reportType === 'RCI'
            ? 'The checks drawn in the period, gathered for certification and forwarded to Accounting. One journal entry is raised from the report as a whole, so the Check Disbursements Journal agrees with the check register line for line.'
            : reportType === 'RADAI'
              ? 'The advices to debit account sent to the bank in the period, certified and forwarded to Accounting for journalizing.'
              : reportType === 'RCD'
                ? 'A collecting officer&rsquo;s receipts for the period with the deposits made against them, certified and forwarded to Accounting.'
                : reportType === 'ERCD_AR'
                  ? "Collections an intermediary made on the municipality's behalf against its own Acknowledgement Receipts, certified by the designated officer. COA Circular 2021-014, Annex E."
                  : reportType === 'ERCD_EOR'
                    ? 'Collections receipted by electronic Official Receipt, including money a payor paid straight into the bank account. Certified by the collecting officer. COA Circular 2021-014, Annex F.'
                    : 'Cash paid out in the period - a cash payroll, for instance - certified by the disbursing officer and forwarded to Accounting.'
        }
        actions={
          canPrepare ? <Button onClick={() => setShowForm(true)}>Prepare {short}</Button> : undefined
        }
      />

      <SectionTabs tabs={SECTION_TABS[reportType]} />

      {aside}

      <Card>
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(r) => r.id}
          loading={loading}
          error={error}
          searchPlaceholder={`${short} number or serial`}
          emptyMessage={`No ${short} for ${fundLabel(fundCode)}, fiscal year ${fiscalYear}.`}
        />
      </Card>

      {showForm && actor && (
        <PrepareReport
          reportType={reportType}
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          actor={actor}
          onClose={() => setShowForm(false)}
          onSaved={() => setShowForm(false)}
        />
      )}

    </>
  );
}

/**
 * Builds the draft.
 *
 * The list is the Treasurer's. The entry is proposed from it so that Accounting
 * receives something to check rather than something to invent, and so the
 * Treasurer can see what the report is asking for before signing it.
 */
function PrepareReport({
  reportType,
  fiscalYear,
  fundCode,
  actor,
  onClose,
  onSaved,
}: {
  reportType: TreasuryReportType;
  fiscalYear: number;
  fundCode: string;
  actor: ReturnType<typeof actorStamp>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const short = TREASURY_REPORT_SHORT[reportType];

  const [reportNo, setReportNo] = useState('');
  const [reportDate, setReportDate] = useState(todayPh());
  const [bankAccountId, setBankAccountId] = useState<string | null>(null);

  /**
   * The chosen account, LOOKED UP rather than remembered.
   *
   * This was a second piece of state that nothing ever wrote to. It was
   * declared, read in two places - the guard below, and the cash line of the
   * proposed entry - and never once set. So it was always null: the report
   * refused to save with "this bank account has no General Ledger account"
   * however carefully the account had been set up, and the entry it proposed
   * had no cash account either.
   *
   * Derived from the id now. There is one source for what the account is, and
   * it is the master record.
   */
  const banks = useBankAccounts(fundCode);
  /*
   * The loaded chart, so an account the office has renamed is named the way
   * the office named it. The built-in titles are the fallback.
   */
  const accounts = useAccounts();
  const accountTitle = useMemo(() => {
    const byCode = new Map(accounts.data.map((a) => [a.code, a.name]));
    return (code: string) => byCode.get(code) ?? null;
  }, [accounts.data]);
  const bankAccount = useMemo(
    () => banks.data.find((b) => b.id === bankAccountId) ?? null,
    [banks.data, bankAccountId],
  );
  const [officerId, setOfficerId] = useState<string | null>(null);
  const [officerName, setOfficerName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const checks = useChecks(reportType === 'RCI' ? (bankAccountId ?? undefined) : undefined);
  const ada = useAda(reportType === 'RADAI' ? (bankAccountId ?? undefined) : undefined);
  const collections = useCollections(fiscalYear, fundCode);
  const payrolls = usePayrolls(fiscalYear, fundCode);

  /**
   * The documents available to report: this fund, not cancelled, and not
   * already claimed by another report. The last condition is the important one
   * - it is what stops the same check appearing on two RCIs.
   */
  const available = useMemo<SourceDoc[]>(() => {
    const unreported = (d: { treasuryReportId?: string; status?: string }) =>
      !d.treasuryReportId && d.status !== 'CANCELLED';

    if (reportType === 'RCI') {
      return checks.data
        .filter((c) => c.fundCode === fundCode && unreported(c))
        .map((c) => ({
          id: c.id,
          sourceNo: c.checkNo,
          date: c.checkDate,
          payeeId: c.payeeId,
          payeeName: c.payeeName,
          particulars: c.particulars,
          amount: c.netAmount,
        }));
    }
    if (reportType === 'RADAI') {
      return ada.data
        .filter((a) => a.fundCode === fundCode && unreported(a))
        .map((a) => ({
          id: a.id,
          sourceNo: a.adaNo,
          date: a.adaDate,
          payeeId: a.payeeId,
          payeeName: a.payeeName,
          particulars: a.particulars,
          amount: a.amount,
        }));
    }
    /*
     * The RCD and the three e-collection reports all draw on `collections`,
     * and each must see only its own half.
     *
     * An e-collection is an ordinary collection carrying a kind - the reasons
     * are on `Collection.eCollectionKind`. The price of that decision is paid
     * here: without the kind filter a GCash receipt would be offered to the
     * RCD as well as to its own report, and whichever was certified first
     * would claim it. The other report would then be short by that amount with
     * nothing saying why.
     *
     * The server refuses the mismatch too, in certifyTreasuryReport. This
     * filter is so the officer is never offered the wrong document; that one
     * is so the browser is not the authority.
     */
    if (reportType === 'RCD' || isECollectionReport(reportType)) {
      const wantedKind = kindForReport(reportType);
      return collections.data
        .filter((c) => unreported(c as never))
        .filter((c) => (c.eCollectionKind ?? null) === wantedKind)
        .map((c) => ({
          id: c.id,
          sourceNo: c.orNumber,
          date: c.orDate,
          payeeName: c.payorName,
          amount: c.totalAmount,
        }));
    }
    return payrolls.data
      .filter((p) => unreported(p as never))
      .map((p) => ({
        id: p.id,
        sourceNo: p.payrollNo ?? '(unnumbered)',
        date: p.periodTo,
        payeeName: p.officeName,
        particulars:
          p.particulars ??
          (p.employeeCount ? `${p.employeeCount} employees` : undefined),
        amount: p.totalNet,
        gross: p.totalGross,
        deductions: p.totalDeductions,
      }));
  }, [reportType, checks.data, ada.data, collections.data, payrolls.data, fundCode]);

  const chosen = available.filter((d) => selected.has(d.id));
  const total = chosen.reduce((s, d) => s + d.amount, 0);

  /**
   * RCDisb only: the payroll figures behind that total, carried onto the report
   * so it prints the way the office writes it. They are not inputs to the
   * entry - the RCDisb liquidates a cash advance, and the only figure the
   * journal needs is the net that left.
   */
  const payrollTotals = useMemo(
    () => ({
      gross: chosen.reduce((s, d) => s + (d.gross ?? 0), 0),
      deductions: chosen.reduce((s, d) => s + (d.deductions ?? 0), 0),
    }),
    [chosen],
  );

  /**
   * The entry each report proposes.
   *
   *   RCI / RADAI   Dr Accounts Payable    Cr Cash in Bank
   *                 The voucher already recognised the payable; the payment
   *                 clears it and takes the cash out of the bank.
   *   RCD           Dr Cash - Collecting Officers    Cr the revenue accounts
   *   RCDisb        Dr Due to Officers and Employees  Cr Advances for Payroll
   *                 The payroll's own liquidation: what was owed to the staff,
   *                 against the cash advance that paid them.
   *
   * Summarised, not itemised: one debit and one credit for the report total.
   * That is what makes the journal agree with the report at a glance, and the
   * detail lives on the report's own lines and in the source documents.
   */
  const entry = useMemo(() => {
    if (total === 0) return [];

    if (reportType === 'RCI' || reportType === 'RADAI') {
      /*
       * The credit line is named from the ACCOUNT CODE, not from the bank
       * account's own name - see cashInBankLine. Taking the name from the bank
       * record is how the proposal came to read "10102020  General Fund",
       * which is not an account in anybody's chart, and the label would have
       * travelled into every ledger line the entry wrote.
       */
      const cash = bankAccount ? cashInBankLine(bankAccount, accountTitle) : null;
      if (!cash) return [];
      /*
       * One payable line per check or advice, each naming its creditor. The
       * shape, and the reasons for it, are in src/lib/treasuryEntry.ts - which
       * the engine reads the same copy of, so a report prepared here and one
       * loaded from a bank file propose the same entry.
       */
      return proposePaymentEntry({
        kind: reportType,
        payable: ACCOUNTS.accountsPayable,
        cash,
        documents: chosen.map((d) => ({
          sourceNo: d.sourceNo,
          payeeId: d.payeeId ?? null,
          payeeName: d.payeeName ?? null,
          particulars: d.particulars ?? null,
          amount: d.amount,
        })),
      });
    }

    if (reportType === 'RCDISB') {
      // The payroll was recognised on its disbursement voucher: the expense was
      // debited there and the net credited to Due to Officers and Employees.
      // The cash advance was drawn separately. All the RCDisb does is close
      // both of those out against each other.
      //
      //   Dr Due to Officers and Employees    what was owed to the staff
      //     Cr Advances for Payroll           the advance that paid them
      //
      // Cash that came back unclaimed is not here. It is receipted and
      // deposited like any other collection, under Collections and Deposits,
      // and reaches the ledger through the RCD. Reporting it in two places
      // would be reporting it twice.
      /*
       * ---- BOTH LINES NAME THE DISBURSING OFFICER ----------------------
       *
       * Advances for Payroll and Due to Officers and Employees are control
       * accounts kept PER OFFICER. The comment in the engine has said so since
       * these entries were written; the entry was going out with no subsidiary
       * at all, so the control accounts carried a balance the subsidiary ledger
       * could not account for - which is the one thing a cash advance has to be
       * answerable by name.
       *
       * The report already knows who: the disbursing officer it was prepared
       * for. Where it somehow does not, the lines go without rather than
       * guessing, and the subsidiary ledger shows a gap that can be found.
       */
      const officer =
        officerId && officerName
          ? {
              subsidiaryType: 'EMPLOYEE' as const,
              subsidiaryId: officerId,
              subsidiaryName: officerName,
            }
          : {};

      return [
        {
          accountCode: ACCOUNTS.dueToOfficersAndEmployees.code,
          accountName: ACCOUNTS.dueToOfficersAndEmployees.name,
          ...officer,
          debit: total,
          credit: 0,
          particulars: `Net pay disbursed per ${short}`,
        },
        {
          accountCode: ACCOUNTS.advancesForPayroll.code,
          accountName: ACCOUNTS.advancesForPayroll.name,
          ...officer,
          debit: 0,
          credit: total,
          particulars: `Liquidation of payroll cash advance per ${short}`,
        },
      ];
    }

    /*
     * RCD and the three e-collection reports: the credits are the revenue
     * accounts the receipts recorded, gathered across the whole report.
     *
     * ---- AND WHAT IS DEBITED -------------------------------------------
     *
     * Annexes E and F  Dr CASH - LOCAL TREASURY, exactly as the RCD does.
     *                  The money is receipted but not yet in the bank: under
     *                  the Collect-Aggregate-Remit scheme the intermediary
     *                  remits on the next banking day, and even Self-Collect
     *                  and Credit has a window. The officer who signed the
     *                  report is accountable for it until it is deposited,
     *                  which is what Cash - Local Treasury means.
     *
     *                  The deposit is then recorded under Deposits like any
     *                  other - Dr Cash in Bank, Cr Cash - Local Treasury - so
     *                  electronic money takes the same two steps as cash and
     *                  the undeposited balance on the face of the annex is a
     *                  figure CFMS already knows.
     *
     * Annex G          Dr CASH IN BANK, named with the bank account. Nobody
     *                  ever held this money: the payor paid the account
     *                  itself, and the report is prepared only once the proof
     *                  of deposit is in hand. Debiting Cash - Local Treasury
     *                  here would make an officer accountable for cash that
     *                  never passed through any hands, and would then need a
     *                  deposit entry for a deposit that already happened.
     */
    const byAccount = new Map<string, { accountCode: string; accountName: string; amount: number }>();
    for (const doc of chosen) {
      const collection = collections.data.find((c) => c.id === doc.id);
      for (const line of collection?.lines ?? []) {
        const existing = byAccount.get(line.accountCode);
        if (existing) existing.amount += line.amount;
        else
          byAccount.set(line.accountCode, {
            accountCode: line.accountCode,
            accountName: line.accountName,
            amount: line.amount,
          });
      }
    }
    return [
      {
        accountCode: ACCOUNTS.cashLocalTreasury.code,
        accountName: ACCOUNTS.cashLocalTreasury.name,
        debit: total,
        credit: 0,
        particulars: `Collections per ${short}`,
      },
      ...[...byAccount.values()].map((a) => ({
        accountCode: a.accountCode,
        accountName: a.accountName,
        debit: 0,
        credit: a.amount,
        particulars: `Collections per ${short}`,
      })),
    ];
  }, [reportType, total, chosen, collections.data, bankAccount, accountTitle, officerId, officerName, short]);

  const entryBalances =
    entry.length > 0 &&
    entry.reduce((s, l) => s + l.debit, 0) === entry.reduce((s, l) => s + l.credit, 0) &&
    entry.reduce((s, l) => s + l.debit, 0) === total;

  const isPayroll = reportType === 'RCDISB';
  const needsBank = reportType === 'RCI' || reportType === 'RADAI';
  /*
   * Annex E is certified by the DESIGNATED OFFICER and Annex F by the
   * COLLECTING OFFICER.
   */
  const needsOfficer =
    reportType === 'RCD' || reportType === 'RCDISB' || isECollectionReport(reportType);

  const save = async () => {
    if (!chosen.length) {
      toast.error('Nothing selected', 'Choose at least one document to report.');
      return;
    }
    if (!reportNo.trim()) {
      toast.error(
        `The ${short} number is missing`,
        "Assign it from the office's own book before saving.",
      );
      return;
    }
    if (needsBank && bankAccount?.glAccountCode && !cashInBankLine(bankAccount, accountTitle)) {
      // The code is set but no title can be found for it, in the loaded chart
      // or in the accounts CFMS posts to by name. Naming it anyway is the
      // fault this check exists to stop.
      toast.error(
        'That bank account posts to a code that is not in the Chart of Accounts',
        `${bankAccount.bankName ?? 'The account'} ${bankAccount.accountNumber ?? ''} says its General Ledger account is ${bankAccount.glAccountCode}, and there is no account with that code. Correct it under Master Data > Banks, or add the account to the chart. The entry cannot name an account that does not exist.`,
      );
      return;
    }
    if (needsBank && !bankAccount?.glAccountCode) {
      // Name the account and the field. "Set it under Master Data - Banks"
      // was true and useless: the screen there is headed Bank Accounts, there
      // may be several of them, and nothing said which one was missing what.
      toast.error(
        'This bank account has no General Ledger account',
        `${bankAccount?.bankName ?? 'The selected account'} ${bankAccount?.accountNumber ?? ''} needs its "General Ledger account" field filled in - the Cash in Bank code it posts to, such as 10102020. Master Data > Banks, open this account, fill that field, save. The entry credits that account, so the report cannot be prepared without it.`,
      );
      return;
    }
    if (!entryBalances) {
      toast.error(
        'The entry does not foot',
        'The proposed entry does not equal the documents selected. Check the receipts on this report.',
      );
      return;
    }

    setSaving(true);
    try {
      /*
       * ---- EVERY OPTIONAL FIELD IS WRITTEN AS NULL, NEVER LEFT UNDEFINED ----
       *
       * A collection has no payee id and no particulars of its own, so for an
       * RCD and for the three e-collection reports both came through as
       * `undefined` - and Firestore refuses a document containing one. It does
       * not drop the field: it rejects the WHOLE write, with
       * "Unsupported field value: undefined", which is what the Treasurer saw
       * instead of a saved report.
       *
       * Null is the honest value anyway. It says the report line has no payee
       * id, which is true of every receipt; undefined said nothing and cost
       * the office the form it had just filled in.
       */
      const lines: TreasuryReportLine[] = chosen.map((d) => ({
        sourceId: d.id,
        sourceNo: d.sourceNo,
        date: d.date,
        payeeId: d.payeeId ?? null,
        payeeName: d.payeeName ?? null,
        particulars: d.particulars ?? null,
        amount: d.amount,
        ...(reportType === 'RCDISB'
          ? { gross: d.gross ?? 0, deductions: d.deductions ?? 0 }
          : {}),
      }));

      await createDraft(
        COL.treasuryReports,
        {
          reportType,
          reportNo: reportNo.trim(),
          reportDate,
          fiscalYear,
          fundCode,
          ...(needsBank && bankAccountId
            ? {
                bankAccountId,
                bankName: bankAccount?.bankName ?? '',
                bankAccountNumber: bankAccount?.accountNumber ?? '',
              }
            : {}),
          ...(needsOfficer && officerId
            ? { accountableOfficerId: officerId, accountableOfficerName: officerName }
            : {}),
          lines,
          totalAmount: total,
          ...(reportType === 'RCDISB'
            ? { totalGross: payrollTotals.gross, totalDeductions: payrollTotals.deductions }
            : {}),
          entry,
          status: 'DRAFT',
        },
        actor,
      );

      toast.success(
        `${short} draft saved`,
        'Review it, then certify to forward it to Accounting.',
      );
      onSaved();
    } catch (err) {
      toast.error('Could not save', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Modal
      open
      title={`Prepare ${short}`}
      size="xl"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={!chosen.length}>
            Save draft
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={`${short} number`} required hint="From the Treasurer's own book.">
          <TextInput
            value={reportNo}
            onChange={(e) => setReportNo(e.target.value)}
            placeholder="100-26-10-0001"
            className="font-mono"
          />
        </Field>

        <Field label="Report date" required>
          <DateInput value={reportDate} onChange={setReportDate} />
        </Field>

        {needsBank && (
          <Field
            label="Bank account"
            required
            hint="The account the payments were drawn on. Its General Ledger account is what the entry credits."
          >
            <BankAccountPicker
              value={bankAccountId}
              fundCode={fundCode}
              onChange={(id) => {
                setBankAccountId(id);
                setSelected(new Set());
              }}
            />
          </Field>
        )}

        {needsOfficer && (
          <Field
            label={
              reportType === 'ERCD_AR'
                ? 'Designated officer'
                : reportType === 'RCD' || reportType === 'ERCD_EOR'
                  ? 'Collecting officer'
                  : 'Disbursing officer'
            }
            hint="The accountable officer this report belongs to, and who certifies it."
          >
            <EmployeePicker
              value={officerId}
              onChange={(id, employee) => {
                setOfficerId(id);
                setOfficerName(employee?.name ?? '');
              }}
            />
          </Field>
        )}
      </div>

      <div className="mt-5">
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-navy-900">
            {isPayroll ? 'Payrolls to report' : 'Documents to report'}
          </h3>
          <span className="text-xs text-slate-500">
            {chosen.length} selected, {formatPeso(total)}
            {isPayroll ? ' paid in cash' : ''}
          </span>
        </div>

        {needsBank && !bankAccountId ? (
          <Alert tone="info">Choose a bank account to see the documents drawn on it.</Alert>
        ) : available.length === 0 ? (
          <Alert tone="info">
            Nothing left to report. Every document for this fund has already been covered by a
            report, which is what should be the case once the period is closed out.
          </Alert>
        ) : (
          <div className="max-h-72 overflow-y-auto rounded border border-slate-200">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-600">
                <tr>
                  <th className="w-10 px-3 py-2" />
                  <th className="px-3 py-2 text-left">No.</th>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Payee / particulars</th>
                  {isPayroll && <th className="px-3 py-2 text-right">Gross</th>}
                  {isPayroll && <th className="px-3 py-2 text-right">Deductions</th>}
                  <th className="px-3 py-2 text-right">{isPayroll ? 'Net paid' : 'Amount'}</th>
                </tr>
              </thead>
              <tbody>
                {available.map((doc) => (
                  <tr key={doc.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(doc.id)}
                        onChange={() => toggle(doc.id)}
                        aria-label={`Include ${doc.sourceNo}`}
                      />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{doc.sourceNo}</td>
                    <td className="px-3 py-2">{formatShortDate(doc.date)}</td>
                    <td className="px-3 py-2">
                      {doc.payeeName ?? ''}
                      {doc.particulars ? (
                        <span className="block text-xs text-slate-500">{doc.particulars}</span>
                      ) : null}
                    </td>
                    {isPayroll && (
                      <td className="px-3 py-2 text-right">
                        <span className="cbo-amount">{formatPeso(doc.gross ?? 0)}</span>
                      </td>
                    )}
                    {isPayroll && (
                      <td className="px-3 py-2 text-right">
                        <span className="cbo-amount">{formatPeso(doc.deductions ?? 0)}</span>
                      </td>
                    )}
                    <td className="px-3 py-2 text-right">
                      <span className="cbo-amount">{formatPeso(doc.amount)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {isPayroll && chosen.length > 0 && (
        <table className="mt-4 w-full border-collapse text-sm">
          <tbody>
            <tr className="border-t border-slate-200">
              <td className="cbo-td">Gross</td>
              <td className="cbo-td cbo-amount">
                {formatPeso(payrollTotals.gross, { symbol: false })}
              </td>
            </tr>
            <tr className="border-t border-slate-100">
              <td className="cbo-td">Less deductions</td>
              <td className="cbo-td cbo-amount">
                {formatPeso(payrollTotals.deductions, { symbol: false, dash: true })}
              </td>
            </tr>
            <tr className="border-t border-slate-200 bg-slate-50 font-semibold">
              <td className="cbo-td">Cash paid</td>
              <td className="cbo-td cbo-amount">{formatPeso(total, { symbol: false })}</td>
            </tr>
          </tbody>
        </table>
      )}

      {entry.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 text-sm font-semibold text-navy-900">
            Entry this report will propose
          </h3>
          <p className="mb-2 text-xs text-slate-500">
            Accounting may adjust this before posting. The total cannot be changed - the journal
            entry must agree with the report you certify.
            {isPayroll
              ? ' It liquidates the payroll cash advance: the expense and the deductions were recognised on the voucher, not here.'
              : ''}
          </p>
          <table className="w-full text-sm">
            <tbody>
              {entry.map((line, i) => (
                <tr key={`${line.accountCode}-${i}`} className="border-t border-slate-100">
                  <td className="py-1.5 font-mono text-xs text-slate-600">{line.accountCode}</td>
                  <td className="py-1.5">{line.accountName}</td>
                  <td className="py-1.5 text-right">
                    {line.debit ? <span className="cbo-amount">{formatPeso(line.debit)}</span> : null}
                  </td>
                  <td className="py-1.5 text-right">
                    {line.credit ? (
                      <span className="cbo-amount">{formatPeso(line.credit)}</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
