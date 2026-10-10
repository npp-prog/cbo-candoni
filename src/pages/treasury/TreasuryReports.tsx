import { useMemo, useState, type ReactNode } from 'react';
import { CoveringCell } from './CoveringCell';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { hereAsReturn, withReturn } from '@/lib/returnTo';
import { proposePaymentEntry } from '@/lib/treasuryEntry';
import { JevLink } from '@/components/JevLink';
import { newestFirst } from '@/lib/registerOrder';
import { creditsByAccountAndSubsidiary, missingSubsidiaries } from '@/lib/collectionSubsidiary';
import {
  cashInBankLine,
  ACCOUNTS_PAYABLE,
  ADVANCES_FOR_PAYROLL,
  CASH_LOCAL_TREASURY,
  DUE_TO_OFFICERS_AND_EMPLOYEES,
} from '@/lib/chartOfAccounts';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { awaitingForward } from '@/lib/treasuryForwarding';
import { GroupedSectionTabs, SectionTabs } from '@/components/ui/SectionTabs';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field, DateInput, TextInput, Select } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { BankAccountPicker, EmployeePicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import {
  useTreasuryReports,
  useChecks,
  useAda,
  useCollections,
  useDeposits,
  useRemittances,
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
import { SECTION_TABS, sectionGroupsFor } from './sections';
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

/** Patch 165: what an RCD is for - see PrepareReport. */
type RcdKind = 'COLLECTION' | 'REMITTANCE' | 'DEPOSIT';

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
  /** Patch 138: an ADA for several payees - its list, for the entry and the bank file. */
  payees?: Array<{ payeeId: string; payeeName: string; accountNumber: string; amount: number }>;
  /** Patch 155: a payroll's disbursing officer - the subsidiary of its entry. */
  officer?: { type: string; id: string; name: string } | null;
  /** Patch 153: a carried-forward payable on another liability (Due to BIR, ...). */
  payableAccount?: { code: string; name: string } | null;
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
  tableFilters,
  alsoType,
}: {
  reportType: TreasuryReportType;
  /**
   * Patch 169: a second type listed with the first - the eRCD's "All", the
   * eOR and the AR reports in one list. Prepare then asks which.
   */
  alsoType?: TreasuryReportType;
  /**
   * Rendered under the tab strip. The e-collection registers use it to carry
   * the choice between Annexes E, F and G - three COA reports that are one
   * piece of work to the officer preparing them, so they share a tab rather
   * than taking three.
   */
  aside?: ReactNode;
  /** Patch 160: controls in the table's own toolbar, before Columns. */
  tableFilters?: ReactNode;
}) {
  const { fiscalYear, fundCode } = useFilters();
  const { can, user, profile } = useAuth();
  const navigate = useNavigate();
  /*
    A report opened from this register comes back to it - the same register,
    the same section of the strip. The report page used to assume Treasury,
    which happened to be right from here and wrong from Accounting; it now
    goes where it was told. See src/lib/returnTo.ts.
  */
  const location = useLocation();
  const openReport = (id: string, suffix = '') =>
    navigate(withReturn(`/treasury/reports/${id}${suffix}`, hereAsReturn(location)));

  const label = TREASURY_REPORT_LABELS[reportType];
  const short = TREASURY_REPORT_SHORT[reportType];

  const first = useTreasuryReports(reportType, fiscalYear, fundCode);
  const second = useTreasuryReports(alsoType ?? reportType, fiscalYear, fundCode);
  const data = useMemo(
    () => (alsoType ? [...(first.data ?? []), ...(second.data ?? [])] : first.data),
    [alsoType, first.data, second.data],
  );
  const loading = first.loading || (alsoType ? second.loading : false);
  const error = first.error ?? (alsoType ? second.error : undefined);

  /* Which strip this report's section draws. See sectionGroupsFor. */
  const sectionGroups = sectionGroupsFor(reportType);

  const rows = useMemo(
    () => newestFirst(data, (r) => ({ ref: r.reportNo, date: r.reportDate })),
    [data],
  );

  /*
   * Patch 165: PREPARE opens in the page itself, not in a window over it - the
   * register gives way to the form, and the browser's Back returns to it.
   */
  const [params, setParams] = useSearchParams();
  const showForm = params.get('prepare') === '1';
  /* With two types listed, the one being prepared rides in the address. */
  const prepareType: TreasuryReportType =
    alsoType && params.get('type') === alsoType ? alsoType : reportType;
  const setShowForm = (on: boolean, type?: TreasuryReportType) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (on) next.set('prepare', '1');
        else next.delete('prepare');
        if (on && (type || alsoType)) next.set('type', type ?? reportType);
        else next.delete('type');
        return next;
      },
      { replace: !on },
    );

  const canPrepare = can('treasury', 'create');

  const actor = user
    ? actorStamp({
        uid: user.uid,
        name: profile?.displayName ?? user.email ?? user.uid,
        position: profile?.position,
      })
    : null;

  const columns: Column<TreasuryReport>[] = [
    ...(alsoType
      ? [
          {
            key: 'reportType',
            header: 'Report',
            width: '8rem',
            value: (r: TreasuryReport) => TREASURY_REPORT_SHORT[r.reportType] ?? r.reportType,
            cell: (r: TreasuryReport) => (
              <span className="text-xs text-slate-600">
                {TREASURY_REPORT_SHORT[r.reportType] ?? r.reportType}
              </span>
            ),
          } satisfies Column<TreasuryReport>,
        ]
      : []),
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
      /* The serial opens the document it names. See CoveringCell. */
      cell: (r) => <CoveringCell report={r} />,
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
          <JevLink jevId={r.jevId} jevNo={r.jevNo} className="font-mono text-xs" />
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

          VIEW REPORT is different, and belongs here. It is not an act on the
          report - it opens the prescribed form, which is reading rather than
          doing, and reading is the thing a clerk comes to this list for. Until
          patch 105 the form was two presses away through the report's own
          page, which is two presses for the most ordinary errand on the
          screen: somebody asks what is on RCI 2026-10-0003 and you print it.

          OPEN is gone (patch 142): the whole row already opens the report.
        */
        <div className="flex items-center justify-end gap-1.5">
          <StatusBadge
            status={r.status}
            label={awaitingForward(r) ? 'Certified - not forwarded' : undefined}
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={(e) => {
              e.stopPropagation();
              openReport(r.id, '/form');
            }}
          >
            View report
          </Button>
        </div>
      ),
    },
  ];

  const strip = sectionGroups ? (
    <GroupedSectionTabs groups={sectionGroups} />
  ) : (
    <SectionTabs tabs={SECTION_TABS[reportType]} />
  );

  if (showForm && actor) {
    return (
      <PrepareReport
        reportType={prepareType}
        fiscalYear={fiscalYear}
        fundCode={fundCode}
        actor={actor}
        tabs={strip}
        onClose={() => setShowForm(false)}
        onSaved={() => setShowForm(false)}
      />
    );
  }

  return (
    <>
      <PageHeader
        title={label}
        breadcrumbs={[{ label: 'Treasury' }, { label: short }]}
        subtitle={
          alsoType
            ? `All of them: the ${TREASURY_REPORT_SHORT[reportType]} and the ${TREASURY_REPORT_SHORT[alsoType]} in one list. Choose one in the list's toolbar to see it alone.`
            : reportType === 'RCI'
            ? 'The checks drawn in the period, certified, then forwarded to Accounting for journalizing.'
            : reportType === 'RADAI'
              ? 'The advices to debit account sent to the bank in the period, certified, then forwarded to Accounting for journalizing.'
              : reportType === 'RCD'
                ? "A collecting officer's receipts for the period with the deposits made against them, certified and forwarded to Accounting."
                : reportType === 'ERCD_AR'
                  ? "Collections an intermediary made on the municipality's behalf against its own Acknowledgement Receipts, certified by the designated officer. COA Circular 2021-014, Annex E."
                  : reportType === 'ERCD_EOR'
                    ? 'Collections receipted by electronic Official Receipt, including money a payor paid straight into the bank account. Certified by the collecting officer. COA Circular 2021-014, Annex F.'
                    : 'Cash paid out in the period - a cash payroll, for instance - certified by the disbursing officer and forwarded to Accounting.'
        }
        actions={
          /*
            Patch 142: the same size and colour as Print on the Claim Sheet,
            in the same place, so moving between the tabs of this strip does
            not move the tabs.
          */
          canPrepare ? (
            alsoType ? (
              <div className="flex gap-2">
                {[reportType, alsoType].map((t) => (
                  <Button key={t} size="sm" variant="primary" onClick={() => setShowForm(true, t)}>
                    Prepare {TREASURY_REPORT_SHORT[t]}
                  </Button>
                ))}
              </div>
            ) : (
              <Button size="sm" variant="primary" onClick={() => setShowForm(true)}>
                Prepare {short}
              </Button>
            )
          ) : undefined
        }
      />

      {/*
        The collections section is drawn in GROUPS - it is the one strip long
        enough to need them. This screen is the RCD and the eRCD as well as
        the RCI, RADAI and RCDisb, so it has to ASK which section it is in
        rather than assume a flat strip.

        It assumed one, which is how patch 97 reached the office with the RCD
        and eRCD still showing twelve tabs on three rows while every other
        screen in the section showed four groups. A build check now refuses
        the flat strip for this section.
      */}
      {sectionGroups ? (
        <GroupedSectionTabs groups={sectionGroups} />
      ) : (
        <SectionTabs tabs={SECTION_TABS[reportType]} />
      )}

      {aside}

      <Card>
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(r) => r.id}
          loading={loading}
          error={error}
          searchPlaceholder={`${short} number or serial`}
          filters={tableFilters}
          /*
            THE WHOLE ROW OPENS THE REPORT. It lights under the pointer, which
            is what says it can be clicked - a list whose rows look like
            print is a list whose rows nobody tries. The serial in Covering
            opens the document instead, and the buttons do what they say;
            each stops its own click so the row does not open as well.
          */
          onRowClick={(r) => openReport(r.id)}
          emptyMessage={`No ${short} for ${fundLabel(fundCode)}, fiscal year ${fiscalYear}.`}
          exportMeta={{
            title: label,
            fundLabel: fundLabel(fundCode),
            periodLabel: `For the fiscal year ${fiscalYear}`,
          }}
          printLayout="landscape"
        />
      </Card>
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
  tabs,
  onClose,
  onSaved,
}: {
  reportType: TreasuryReportType;
  fiscalYear: number;
  fundCode: string;
  actor: ReturnType<typeof actorStamp>;
  /** Patch 165: the section's tab strip, drawn above the form. */
  tabs?: ReactNode;
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
  /*
   * Patch 165 - WHAT THIS RCD IS FOR, chosen first:
   *   COLLECTION  a collecting officer's own receipts (A.1);
   *   REMITTANCE  the collectors' RCDs remitted to the Liquidating Officer (A.2);
   *   DEPOSIT     the deposits the Liquidating Officer or the Treasurer made of
   *               what was remitted to them (B).
   * The officer list and the documents offered follow the choice.
   */
  const isRcd = reportType === 'RCD';
  const [rcdKind, setRcdKind] = useState<RcdKind>('COLLECTION');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /* Patch 157: an RCD's deposits (Section B), chosen apart from its collections. */
  const [selectedDeposits, setSelectedDeposits] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  /* Patch 161: Section A.2 - the remittances the officer received. */
  const [selectedRemittances, setSelectedRemittances] = useState<Set<string>>(new Set());
  const remittancesQ = useRemittances(fiscalYear, fundCode);
  const rcdReportsQ = useTreasuryReports('RCD', fiscalYear, fundCode);

  const checks = useChecks(reportType === 'RCI' ? (bankAccountId ?? undefined) : undefined);
  const ada = useAda(reportType === 'RADAI' ? (bankAccountId ?? undefined) : undefined);
  const collections = useCollections(fiscalYear, fundCode);
  const payrolls = usePayrolls(fiscalYear, fundCode);
  const depositsQ = useDeposits();
  /*
   * Patch 157. The deposits an RCD may report: this fund, not cancelled, not
   * yet on an RCD. Patch 159: any of them - the RCD's entry books it.
   */
  const reportableDeposits = useMemo(
    () =>
      reportType !== 'RCD' || rcdKind !== 'DEPOSIT'
        ? []
        : depositsQ.data
            .filter((d) => d.fundCode === fundCode && d.status !== 'CANCELLED')
            .filter((d) => !d.treasuryReportId)
            .filter((d) => !officerId || d.collectingOfficerId === officerId)
            .sort((a, b) => a.depositDate.localeCompare(b.depositDate)),
    [reportType, rcdKind, officerId, depositsQ.data, fundCode],
  );
  /*
   * Patch 161: the remittances the RCD's officer received from collectors and
   * no RCD has reported yet (Section A.2).
   */
  const reportableRemittances = useMemo(
    () =>
      reportType !== 'RCD' || rcdKind !== 'REMITTANCE'
        ? []
        : remittancesQ.data
            .filter((m) => m.status === 'RECORDED' && !m.liquidatingReportId)
            .filter((m) => !officerId || m.liquidatingOfficerId === officerId)
            .sort((a, b) => a.remittanceDate.localeCompare(b.remittanceDate)),
    [reportType, rcdKind, remittancesQ.data, officerId],
  );
  const chosenRemittances = reportableRemittances.filter((m) => selectedRemittances.has(m.id));
  const remittanceTotal = chosenRemittances.reduce((t, m) => t + m.amount, 0);
  /** Undeposited from the officer's earlier certified RCDs (as Section D). */
  const carried = useMemo(() => {
    if (reportType !== 'RCD' || !officerId) return 0;
    // Patch 166: certified or not - only a cancelled RCD is left out.
    const earlier = rcdReportsQ.data.filter(
      (r) => r.accountableOfficerId === officerId && r.status !== 'CANCELLED',
    );
    const ids = new Set(earlier.map((r) => r.id));
    const inHand = earlier.reduce(
      (t, r) => t + (r.totalAmount ?? 0) + (r.totalRemittances ?? 0) - (r.totalDeposits ?? 0),
      0,
    );
    const remitted = remittancesQ.data
      .filter(
        (m) => m.status !== 'CANCELLED' && m.collectorReportId && ids.has(m.collectorReportId),
      )
      .reduce((t, m) => t + m.amount, 0);
    return Math.max(0, inHand - remitted);
  }, [reportType, officerId, rcdReportsQ.data, remittancesQ.data]);
  /** Patch 165: what the officer's DRAFT RCDs would add once certified. */

  const chosenDeposits = reportableDeposits.filter((d) => selectedDeposits.has(d.id));
  const depositTotal = chosenDeposits.reduce((s, d) => s + d.amount, 0);

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
          // Patch 153: another liability than Accounts Payable, if the voucher was carried on one.
          payableAccount:
            c.payableAccountCode && c.payableAccountCode !== ACCOUNTS.accountsPayable.code
              ? { code: c.payableAccountCode, name: c.payableAccountName ?? c.payableAccountCode }
              : null,
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
          // Patch 153: another liability than Accounts Payable, if the voucher was carried on one.
          payableAccount:
            a.payableAccountCode && a.payableAccountCode !== ACCOUNTS.accountsPayable.code
              ? { code: a.payableAccountCode, name: a.payableAccountName ?? a.payableAccountCode }
              : null,
          payees: (a.payees ?? [])
            .filter((p) => p.payeeId)
            .map((p) => ({
              payeeId: p.payeeId as string,
              payeeName: p.payeeName,
              accountNumber: p.accountNumber,
              amount: p.amount,
            })),
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
      // Patch 165: an RCD of collections shows the chosen officer's receipts only.
      if (reportType === 'RCD' && (rcdKind !== 'COLLECTION' || !officerId)) return [];
      return collections.data
        .filter((c) => unreported(c as never))
        .filter((c) => (c.eCollectionKind ?? null) === wantedKind)
        .filter((c) => reportType !== 'RCD' || c.collectingOfficerId === officerId)
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
        // Patch 155: the disbursing officer, where the payroll names one.
        payeeName: p.disbursingOfficer?.name ?? p.officeName,
        officer: p.disbursingOfficer ?? null,
        particulars:
          p.particulars ??
          (p.employeesCovered || (p.employeeCount ? `${p.employeeCount} employees` : undefined)),
        amount: p.totalNet,
        gross: p.totalGross,
        deductions: p.totalDeductions,
      }));
  }, [
    reportType,
    rcdKind,
    officerId,
    checks.data,
    ada.data,
    collections.data,
    payrolls.data,
    fundCode,
  ]);

  /*
   * Patch 165: the officers an RCD of each kind can be prepared for - those
   * with something waiting: receipts not yet reported (collection), remittances
   * received and not yet reported (remittance), deposits not yet reported
   * (deposit).
   */
  const rcdOfficers = useMemo(() => {
    if (!isRcd) return [];
    const m = new Map<string, { id: string; name: string; count: number; amount: number }>();
    const add = (
      id: string | null | undefined,
      name: string | null | undefined,
      amount: number,
    ) => {
      if (!id) return;
      const cur = m.get(id) ?? { id, name: name ?? id, count: 0, amount: 0 };
      cur.count += 1;
      cur.amount += amount;
      m.set(id, cur);
    };
    if (rcdKind === 'COLLECTION') {
      for (const c of collections.data) {
        if (c.treasuryReportId || c.status === 'CANCELLED' || c.eCollectionKind) continue;
        add(c.collectingOfficerId, c.collectingOfficerName, c.totalAmount);
      }
    } else if (rcdKind === 'REMITTANCE') {
      for (const r of remittancesQ.data) {
        if (r.status !== 'RECORDED' || r.liquidatingReportId) continue;
        add(r.liquidatingOfficerId, r.liquidatingOfficerName, r.amount);
      }
    } else {
      for (const d of depositsQ.data) {
        if (d.fundCode !== fundCode || d.status === 'CANCELLED' || d.treasuryReportId) continue;
        add(d.collectingOfficerId, d.collectingOfficerName, d.amount);
      }
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [isRcd, rcdKind, collections.data, remittancesQ.data, depositsQ.data, fundCode]);

  const chosen = available.filter((d) => selected.has(d.id));
  const total = chosen.reduce((s, d) => s + d.amount, 0);

  /*
   * Patch 156. On an RCDisb the disbursing officer is not chosen: it is the
   * payee of the advance each payroll liquidates (carried on the payroll as
   * its disbursing officer). One RCDisb is one officer's report, so payrolls
   * of two officers cannot be reported together.
   */
  const payrollOfficers = useMemo(() => {
    if (reportType !== 'RCDISB') return [];
    const m = new Map<string, { type: string; id: string; name: string }>();
    for (const d of chosen) if (d.officer) m.set(`${d.officer.type}:${d.officer.id}`, d.officer);
    return [...m.values()];
  }, [reportType, chosen]);
  const payrollOfficer = payrollOfficers.length === 1 ? payrollOfficers[0] : null;
  const effOfficerId = payrollOfficer ? payrollOfficer.id : officerId;
  const effOfficerName = payrollOfficer ? payrollOfficer.name : officerName;

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
  const collectionEntry = useMemo(() => {
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
        reportNo: reportNo.trim(),
        documents: chosen.map((d) => ({
          sourceNo: d.sourceNo,
          payeeId: d.payeeId ?? null,
          payeeName: d.payeeName ?? null,
          particulars: d.particulars ?? null,
          amount: d.amount,
          payees: d.payees && d.payees.length ? d.payees : null,
          payableAccount: d.payableAccount ?? null,
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
      const chosenOfficer =
        officerId && officerName ? { type: 'EMPLOYEE', id: officerId, name: officerName } : null;
      // (Each payroll's own officer takes precedence; see payrollOfficers.)

      /*
       * Patch 155: each payroll names its own disbursing officer - the
       * subsidiary its advance was booked to - and its lines go to THAT
       * subsidiary account, so the advance is liquidated where it was
       * granted. A payroll recorded before patch 155 has none, and takes the
       * officer chosen for the report, as before. One pair of lines per
       * officer; one payroll's particulars when the officer has one payroll.
       */
      const groups = new Map<
        string,
        {
          officer: { type: string; id: string; name: string } | null;
          amount: number;
          parts: string[];
        }
      >();
      for (const d of chosen) {
        const o = d.officer ?? chosenOfficer;
        const key = o ? `${o.type}:${o.id}` : '';
        const g = groups.get(key) ?? { officer: o, amount: 0, parts: [] };
        g.amount += d.amount;
        if (d.particulars) g.parts.push(d.particulars);
        groups.set(key, g);
      }
      const sub = (o: { type: string; id: string; name: string } | null) =>
        o ? { subsidiaryType: o.type, subsidiaryId: o.id, subsidiaryName: o.name } : {};
      const words = (g: { parts: string[] }) =>
        g.parts.length === 1 ? g.parts[0] : `Liquidation of payroll per ${short}`;
      const list = [...groups.values()];

      return [
        ...list.map((g) => ({
          accountCode: ACCOUNTS.dueToOfficersAndEmployees.code,
          accountName: ACCOUNTS.dueToOfficersAndEmployees.name,
          ...sub(g.officer),
          debit: g.amount,
          credit: 0,
          particulars: words(g),
        })),
        ...list.map((g) => ({
          accountCode: ACCOUNTS.advancesForPayroll.code,
          accountName: ACCOUNTS.advancesForPayroll.name,
          ...sub(g.officer),
          debit: 0,
          credit: g.amount,
          particulars: words(g),
        })),
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
    // Patch 157: an RCD of deposits only proposes no entry.
    if (chosen.length === 0) return [];
    /*
     * Patch 158: one credit per account AND subsidiary ledger account - a
     * refund of an advance credits Advances for Payroll in the officer's own
     * account, a bidder's bond the bidder's, and revenue kept per party its
     * payor's.
     */
    const credits = creditsByAccountAndSubsidiary(
      chosen.flatMap((doc) => collections.data.find((c) => c.id === doc.id)?.lines ?? []),
    );
    /*
     * Patch 156: e-collections are presented as DEPOSITED. Nobody held the
     * money - it was credited to the bank account directly - so an eRCD
     * debits Cash in Bank (that account), not Cash - Local Treasury, and no
     * deposit slip follows it. The RCD (cash) keeps Cash - Local Treasury.
     */
    const ecash = isECollectionReport(reportType)
      ? bankAccount
        ? cashInBankLine(bankAccount, accountTitle)
        : null
      : null;
    if (isECollectionReport(reportType) && !ecash) return [];
    return [
      ecash
        ? { ...ecash, debit: total, credit: 0, particulars: `e-Collections credited per ${short}` }
        : {
            accountCode: ACCOUNTS.cashLocalTreasury.code,
            accountName: ACCOUNTS.cashLocalTreasury.name,
            debit: total,
            credit: 0,
            particulars: `Collections per ${short}`,
          },
      ...credits.map((a) => ({
        accountCode: a.accountCode,
        accountName: a.accountName,
        ...(a.subsidiaryId
          ? {
              subsidiaryType: a.subsidiaryType,
              subsidiaryId: a.subsidiaryId,
              subsidiaryName: a.subsidiaryName,
            }
          : {}),
        debit: 0,
        credit: a.amount,
        particulars: `Collections per ${short}`,
      })),
    ];
  }, [
    reportType,
    reportNo,
    total,
    chosen,
    collections.data,
    bankAccount,
    accountTitle,
    officerId,
    officerName,
    short,
  ]);

  /*
   * Patch 159 - EVERY DEPOSIT IS BOOKED BY THE RCD THAT REPORTS IT.
   *
   * A deposit used to be booked on its own, by Deposits > Post. It is now
   * recorded there and booked here, in this RCD's entry:
   *
   *     Dr Cash in Bank - <the deposit's bank account>
   *       Cr Cash - Local Treasury - <the collecting officer>
   *
   * so the RCD is the one document that moves the cash: collections in,
   * deposits out. A deposit posted before patch 159 already has its entry
   * and is reported without a second one.
   */
  const depositsToBook = useMemo(
    () => (reportType === 'RCD' ? chosenDeposits.filter((d) => !d.jevId) : []),
    [reportType, chosenDeposits],
  );
  const toBookTotal = depositsToBook.reduce((s, d) => s + d.amount, 0);
  /** A deposit's bank, from the slip or else from its bank account record. */
  const bankOfDeposit = (d: {
    bankAccountId: string;
    bankName?: string;
    bankAccountNumber?: string;
  }) => {
    const b = banks.data.find((x) => x.id === d.bankAccountId);
    return {
      bankName: d.bankName || b?.bankName || '',
      bankAccountNumber: d.bankAccountNumber || b?.accountNumber || '',
    };
  };
  const depositEntry = useMemo(() => {
    const out: Array<{
      accountCode: string;
      accountName: string;
      debit: number;
      credit: number;
      particulars: string;
      subsidiaryType?: string | null;
      subsidiaryId?: string | null;
      subsidiaryName?: string | null;
    }> = [];
    for (const d of depositsToBook) {
      const bank = banks.data.find((b) => b.id === d.bankAccountId);
      const cib = bank ? cashInBankLine(bank, accountTitle) : null;
      if (!cib) continue;
      out.push({
        ...cib,
        debit: d.amount,
        credit: 0,
        particulars: `Deposit slip ${d.depositSlipNo}`,
      });
    }
    for (const d of depositsToBook) {
      out.push({
        accountCode: ACCOUNTS.cashLocalTreasury.code,
        accountName: ACCOUNTS.cashLocalTreasury.name,
        ...(d.collectingOfficerId
          ? {
              subsidiaryType: 'EMPLOYEE',
              subsidiaryId: d.collectingOfficerId,
              subsidiaryName: d.collectingOfficerName ?? null,
            }
          : {}),
        debit: 0,
        credit: d.amount,
        particulars: `Deposit of collections per slip ${d.depositSlipNo}`,
      });
    }
    return out;
  }, [depositsToBook, banks.data, accountTitle]);
  /** A deposit whose bank account names no Cash in Bank account the chart has. */
  const depositBankProblem = depositsToBook.find((d) => {
    const bank = banks.data.find((b) => b.id === d.bankAccountId);
    return !bank || !cashInBankLine(bank, accountTitle);
  });
  const entry = useMemo(
    () => [...collectionEntry, ...depositEntry],
    [collectionEntry, depositEntry],
  );

  const entryBalances =
    entry.length > 0 &&
    entry.reduce((s, l) => s + l.debit, 0) === entry.reduce((s, l) => s + l.credit, 0) &&
    entry.reduce((s, l) => s + l.debit, 0) === total + toBookTotal;

  const isPayroll = reportType === 'RCDISB';
  /*
   * Patch 156: an eRCD names the bank account too - the e-collections were
   * credited straight to it, and the entry debits it (see the entry above).
   */
  const needsBank =
    reportType === 'RCI' || reportType === 'RADAI' || isECollectionReport(reportType);
  /*
   * Annex E is certified by the DESIGNATED OFFICER and Annex F by the
   * COLLECTING OFFICER.
   */
  const needsOfficer =
    reportType === 'RCD' || reportType === 'RCDISB' || isECollectionReport(reportType);

  const save = async () => {
    // Patch 157 / 161: an RCD may carry deposits or remittances received only.
    if (
      !chosen.length &&
      !(reportType === 'RCD' && (chosenDeposits.length || chosenRemittances.length))
    ) {
      toast.error(
        'Nothing selected',
        reportType === 'RCD'
          ? rcdKind === 'COLLECTION'
            ? 'Choose the collecting officer and at least one of their receipts.'
            : rcdKind === 'REMITTANCE'
              ? 'Choose the Liquidating Officer and at least one remittance they received.'
              : 'Choose the officer and at least one deposit they made.'
          : 'Choose at least one document to report.',
      );
      return;
    }
    /*
     * Patch 161: NO DEPOSIT WITHOUT THE MONEY - the officer deposits what they
     * hold: this RCD's collections, the remittances received in A.2, and what
     * their earlier RCDs left undeposited.
     */
    if (reportType === 'RCD' && depositTotal > 0) {
      const available = carried + total + remittanceTotal;
      if (depositTotal > available) {
        toast.error(
          'Deposits without a remittance',
          `The deposits chosen (${formatPeso(depositTotal)}) are more than the officer holds: ${formatPeso(available)} - collections ${formatPeso(total)}, remittances received ${formatPeso(remittanceTotal)}, undeposited from earlier RCDs ${formatPeso(carried)}. Tick the remittances the deposit was made from under "Remittances received (A.2)".`,
        );
        return;
      }
    }
    if (reportType === 'RCDISB' && payrollOfficers.length > 1) {
      toast.error(
        'Payrolls of two disbursing officers',
        `The payrolls chosen were disbursed by ${payrollOfficers.map((o) => o.name).join(' and ')}. An RCDisb is one disbursing officer's report - prepare one for each.`,
      );
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
    /*
     * Patch 158: a receipt line on a receivable or a payable (or a revenue
     * account kept per party) names its subsidiary ledger account, and the
     * entry credits it there. One that came in without - a bulk upload, or a
     * receipt recorded before patch 158 - is corrected on the receipt first.
     */
    if (reportType === 'RCD' || isECollectionReport(reportType)) {
      const lacking = chosen.flatMap((doc) => {
        const c = collections.data.find((x) => x.id === doc.id);
        const miss = missingSubsidiaries(
          c?.lines ?? [],
          (code) => accounts.data.find((a) => a.code === code) ?? null,
        );
        return miss.length ? [`OR ${doc.sourceNo} ${miss.join(', ')}`] : [];
      });
      if (lacking.length > 0) {
        toast.error(
          'A receipt does not name its subsidiary ledger account',
          `${lacking.join('; ')}. Open the receipt, Correct, and choose whose account it is - the entry credits that account per party.`,
        );
        return;
      }
    }
    if (depositBankProblem) {
      toast.error(
        'A deposit cannot be booked',
        `Deposit slip ${depositBankProblem.depositSlipNo} is to a bank account with no Cash in Bank account in the chart. Master Data > Banks, open the account and fill its General Ledger account.`,
      );
      return;
    }
    if (!entryBalances && (chosen.length > 0 || toBookTotal > 0)) {
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
        ...(d.payees && d.payees.length ? { payees: d.payees } : {}),
        ...(reportType === 'RCDISB' ? { gross: d.gross ?? 0, deductions: d.deductions ?? 0 } : {}),
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
          ...(needsOfficer && effOfficerId
            ? { accountableOfficerId: effOfficerId, accountableOfficerName: effOfficerName }
            : {}),
          lines,
          totalAmount: total,
          ...(reportType === 'RCD'
            ? {
                rcdKind,
                deposits: chosenDeposits.map((d) => ({
                  sourceId: d.id,
                  depositSlipNo: d.depositSlipNo ?? '',
                  date: d.depositDate,
                  bankName: bankOfDeposit(d).bankName,
                  bankAccountNumber: bankOfDeposit(d).bankAccountNumber,
                  amount: d.amount,
                })),
                totalDeposits: depositTotal,
                // Patch 161: Section A.2.
                remittances: chosenRemittances.map((m) => ({
                  sourceId: m.id,
                  collectorName: m.collectingOfficerName,
                  collectorReportNo: m.collectorReportNo ?? null,
                  date: m.remittanceDate,
                  amount: m.amount,
                })),
                totalRemittances: remittanceTotal,
              }
            : {}),
          ...(reportType === 'RCDISB'
            ? { totalGross: payrollTotals.gross, totalDeductions: payrollTotals.deductions }
            : {}),
          entry,
          status: 'DRAFT',
        },
        actor,
      );

      toast.success(`${short} draft saved`, 'Review it, then certify to forward it to Accounting.');
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

  const buttons = (
    <>
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      <Button
        variant="primary"
        onClick={save}
        loading={saving}
        // Patch 161: an RCD of deposits or remittances only may be saved too.
        disabled={!chosen.length && !chosenDeposits.length && !chosenRemittances.length}
      >
        Save draft
      </Button>
    </>
  );

  const RCD_KINDS: Array<{ id: RcdKind; label: string; hint: string }> = [
    {
      id: 'COLLECTION',
      label: 'Collection',
      hint: "A collecting officer's own receipts (Section A.1).",
    },
    {
      id: 'REMITTANCE',
      label: 'Remittance',
      hint: "The collectors' RCDs remitted to the Liquidating Officer (Section A.2).",
    },
    {
      id: 'DEPOSIT',
      label: 'Deposit',
      hint: 'The deposits the Liquidating Officer or the Treasurer made of what was remitted (Section B).',
    },
  ];
  const officerLabel =
    rcdKind === 'COLLECTION'
      ? 'Collecting officer'
      : rcdKind === 'REMITTANCE'
        ? 'Liquidating officer'
        : 'Liquidating officer or Treasurer';

  return (
    <>
      {/* Patch 165: the form fills the page instead of opening in a window. */}
      <PageHeader
        title={`Prepare ${short}`}
        breadcrumbs={[{ label: 'Treasury' }, { label: short }, { label: 'Prepare' }]}
        subtitle={TREASURY_REPORT_LABELS[reportType]}
        actions={buttons}
      />
      {tabs}
      <Card>
        {isRcd && (
          <div className="mb-5">
            <p className="cbo-label mb-2">This RCD is for</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {RCD_KINDS.map((k) => (
                <label
                  key={k.id}
                  className={`flex cursor-pointer gap-2 rounded-md border px-3 py-2 text-sm ${
                    rcdKind === k.id
                      ? 'border-brand-500 bg-brand-50 text-navy-900'
                      : 'border-slate-200 text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <input
                    type="radio"
                    name="rcdKind"
                    className="mt-0.5"
                    checked={rcdKind === k.id}
                    onChange={() => {
                      setRcdKind(k.id);
                      setOfficerId(null);
                      setOfficerName('');
                      setSelected(new Set());
                      setSelectedDeposits(new Set());
                      setSelectedRemittances(new Set());
                    }}
                  />
                  <span>
                    <span className="font-semibold">{k.label}</span>
                    <span className="block text-xs text-slate-500">{k.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}
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
              hint={
                isECollectionReport(reportType)
                  ? 'The account the e-collections were credited to. Its General Ledger account is what the entry debits.'
                  : 'The account the payments were drawn on. Its General Ledger account is what the entry credits.'
              }
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
                isRcd
                  ? officerLabel
                  : reportType === 'ERCD_AR'
                    ? 'Designated officer'
                    : reportType === 'ERCD_EOR'
                      ? 'Collecting officer'
                      : 'Disbursing officer'
              }
              hint="The accountable officer this report belongs to, and who certifies it."
            >
              {isRcd ? (
                /*
                 * Patch 165: the officers with something waiting for this kind
                 * of RCD - and, once one is chosen, only that officer's
                 * documents below.
                 */
                rcdOfficers.length === 0 ? (
                  <p className="py-2 text-sm text-slate-500">
                    {rcdKind === 'COLLECTION'
                      ? 'No collecting officer has receipts waiting to be reported.'
                      : rcdKind === 'REMITTANCE'
                        ? 'No remittance received is waiting to be reported.'
                        : 'No deposit is waiting to be reported.'}
                  </p>
                ) : (
                  <Select
                    value={officerId ?? ''}
                    onChange={(e) => {
                      const o = rcdOfficers.find((x) => x.id === e.target.value);
                      setOfficerId(o?.id ?? null);
                      setOfficerName(o?.name ?? '');
                      setSelected(new Set());
                      setSelectedDeposits(new Set());
                      setSelectedRemittances(new Set());
                    }}
                  >
                    <option value="">Choose the officer</option>
                    {rcdOfficers.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name} - {o.count} waiting, {formatPeso(o.amount)}
                      </option>
                    ))}
                  </Select>
                )
              ) : reportType === 'RCDISB' && payrollOfficers.length > 0 ? (
                /* Patch 156: the payee of the advance the payrolls liquidate. */
                <p className="py-2 text-sm font-medium text-navy-900">
                  {payrollOfficer
                    ? payrollOfficer.name
                    : `Two officers chosen: ${payrollOfficers.map((o) => o.name).join(', ')}`}
                </p>
              ) : (
                <EmployeePicker
                  value={officerId}
                  onChange={(id, employee) => {
                    setOfficerId(id);
                    setOfficerName(employee?.name ?? '');
                  }}
                />
              )}
            </Field>
          )}
        </div>

        {(!isRcd || rcdKind === 'COLLECTION') && (
          <div className="mt-5">
            <div className="mb-2 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-navy-900">
                {isPayroll
                  ? 'Payrolls to report'
                  : isRcd
                    ? 'Receipts to report (A.1)'
                    : 'Documents to report'}
              </h3>
              <span className="text-xs text-slate-500">
                {chosen.length} selected, {formatPeso(total)}
                {isPayroll ? ' paid in cash' : ''}
              </span>
            </div>

            {(reportType === 'RCI' || reportType === 'RADAI') && !bankAccountId ? (
              <Alert tone="info">Choose a bank account to see the documents drawn on it.</Alert>
            ) : isRcd && !officerId ? (
              <Alert tone="info">
                Choose the collecting officer; their receipts are listed here.
              </Alert>
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
        )}

        {/* Patch 161: Section A.2 - remittances received from collectors. */}
        {reportType === 'RCD' && rcdKind === 'REMITTANCE' && (
          <div className="mt-5">
            <div className="mb-2 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-navy-900">Remittances received (A.2)</h3>
              <span className="text-xs text-slate-500">
                {chosenRemittances.length} selected, {formatPeso(remittanceTotal)}
              </span>
            </div>
            <p className="mb-2 text-xs text-slate-500">
              The collectors&apos; remittances {officerId ? 'this officer' : 'the officer'} received
              (Treasury &gt; Collections and Deposits &gt; Remittances). They transfer
              accountability and are not in the entry. A deposit is made from them: the deposits
              below cannot exceed the remittances received, this RCD&apos;s own collections and what
              is still undeposited from earlier RCDs ({formatPeso(carried)}).
            </p>
            {reportableRemittances.length === 0 ? (
              <Alert tone="info">
                {officerId
                  ? 'No remittance received by this officer is waiting to be reported.'
                  : 'Choose the officer first; the remittances they received are listed here.'}
              </Alert>
            ) : (
              <div className="max-h-56 overflow-y-auto rounded border border-slate-200">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="w-10 px-3 py-2" />
                      <th className="px-3 py-2 text-left">Collector</th>
                      <th className="px-3 py-2 text-left">Collector&apos;s RCD</th>
                      <th className="px-3 py-2 text-left">Date</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportableRemittances.map((m) => (
                      <tr key={m.id} className="border-t border-slate-100">
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={selectedRemittances.has(m.id)}
                            onChange={() =>
                              setSelectedRemittances((prev) => {
                                const next = new Set(prev);
                                if (next.has(m.id)) next.delete(m.id);
                                else next.add(m.id);
                                return next;
                              })
                            }
                            aria-label={`Include remittance of ${m.collectingOfficerName}`}
                          />
                        </td>
                        <td className="px-3 py-2">{m.collectingOfficerName}</td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {m.collectorReportNo ?? '-'}
                        </td>
                        <td className="px-3 py-2">{formatShortDate(m.remittanceDate)}</td>
                        <td className="px-3 py-2 text-right">
                          <span className="cbo-amount">{formatPeso(m.amount)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Patch 157: Section B - the deposits this RCD accounts for. */}
        {reportType === 'RCD' && rcdKind === 'DEPOSIT' && (
          <div className="mt-5">
            <div className="mb-2 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-navy-900">Deposits to report</h3>
              <span className="text-xs text-slate-500">
                {chosenDeposits.length} selected, {formatPeso(depositTotal)}
              </span>
            </div>
            <p className="mb-2 text-xs text-slate-500">
              The deposits {officerId ? 'this officer' : 'the officer'} made (Treasury &gt;
              Collections and Deposits &gt; Deposits). Every deposit is booked by the RCD that
              reports it: Dr Cash in Bank / Cr Cash - Local Treasury, in the entry below.
            </p>
            {officerId && (
              <div className="mb-3 grid gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm sm:grid-cols-2">
                <span>
                  Remitted to this officer and not yet deposited:{' '}
                  <span className="cbo-amount font-semibold">{formatPeso(carried)}</span>
                </span>
                <span className={depositTotal > carried ? 'text-rose-700' : ''}>
                  Deposits ticked: <span className="cbo-amount">{formatPeso(depositTotal)}</span>
                </span>
              </div>
            )}
            {!officerId ? (
              <Alert tone="info">Choose the officer; the deposits they made are listed here.</Alert>
            ) : reportableDeposits.length === 0 ? (
              <Alert tone="info">No deposit of this officer is waiting to be reported.</Alert>
            ) : (
              <div className="max-h-56 overflow-y-auto rounded border border-slate-200">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="w-10 px-3 py-2" />
                      <th className="px-3 py-2 text-left">Deposit slip</th>
                      <th className="px-3 py-2 text-left">Date</th>
                      <th className="px-3 py-2 text-left">Bank</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportableDeposits.map((d) => {
                      const booked = Boolean(d.jevId);
                      return (
                        <tr key={d.id} className="border-t border-slate-100">
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              checked={selectedDeposits.has(d.id)}
                              onChange={() =>
                                setSelectedDeposits((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(d.id)) next.delete(d.id);
                                  else next.add(d.id);
                                  return next;
                                })
                              }
                              aria-label={`Include deposit ${d.depositSlipNo}`}
                            />
                          </td>
                          <td className="px-3 py-2 font-mono text-xs">
                            {d.depositSlipNo}
                            {booked && (
                              <span className="block font-sans text-2xs text-slate-500">
                                Already booked (posted before patch 159) - no second entry
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2">{formatShortDate(d.depositDate)}</td>
                          <td className="px-3 py-2 text-xs">
                            {bankOfDeposit(d).bankName} {bankOfDeposit(d).bankAccountNumber}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <span className="cbo-amount">{formatPeso(d.amount)}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

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
                    <td className="py-1.5">
                      {line.accountName}
                      {'subsidiaryName' in line && line.subsidiaryName ? (
                        <span className="block text-xs text-slate-500">{line.subsidiaryName}</span>
                      ) : null}
                    </td>
                    <td className="py-1.5 text-right">
                      {line.debit ? (
                        <span className="cbo-amount">{formatPeso(line.debit)}</span>
                      ) : null}
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
        <div className="mt-6 flex justify-end gap-2 border-t border-slate-200 pt-4">{buttons}</div>
      </Card>
    </>
  );
}
