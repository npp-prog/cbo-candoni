import { Link, useSearchParams } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import { useDocument } from '@/hooks/useFirestore';
import { ADVANCES_FOR_PAYROLL } from '@/lib/chartOfAccounts';
import { refundReceiptDraft } from '@/lib/payrollAdvances';
import type { Payroll as PayrollRecord } from '@/types/accounting';
import { PageHeader, Alert } from '@/components/ui/Layout';
import { GroupedSectionTabs } from '@/components/ui/SectionTabs';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Field, Select, DateInput, AmountInput, TextInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { AccountPicker, EmployeePicker } from '@/components/pickers';
import { LineSubsidiary } from '@/components/pickers/LineSubsidiary';
import { missingSubsidiaries } from '@/lib/collectionSubsidiary';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import {
  useAccountableFormTypes,
  useFormMovements,
  useAccounts,
  useBarangays,
  useCollections,
  useRemittances,
  useTrustPrograms,
} from '@/data/queries';
import { allocateRemittances } from '@/lib/remittances';
import { holdsSerial, normaliseFormCode, officerHoldings } from '@/lib/formCustody';
import { createDraft, updateDraft, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { formatPeso } from '@/lib/money';
import { TRUST_FUND_CODE } from '@/lib/trustPrograms';
import { isRptAccount, sharesWithBarangay } from '@/pages/reports/rptAbstractReport';
import { receiptDetailProblems, describeProblems, receiptIsIncomplete } from '@/lib/receiptDetail';
import { formatShortDate, monthName, todayPh } from '@/lib/dates';
import { REVENUE_SOURCES } from '@/types/treasury';
import type { Collection, CollectionLine, RevenueSource } from '@/types/treasury';

type RefundPrefill = NonNullable<ReturnType<typeof refundReceiptDraft>>;
import { fundLabel } from '../budget/Obligations';
import { COLLECTION_TAB_GROUPS, COLLECTION_CRUMBS } from './sections';
import { CollectionDetail } from './CollectionDetail';
import { OfflineSetupDownload } from './OfflineSetupDownload';


/**
 * Collections and official receipts.
 *
 * An official receipt, once issued to a citizen, is not editable - it is a
 * document in someone else's hands. Only non-monetary corrections are allowed
 * before it enters an RCD, and beyond that it is cancelled and reissued.
 * Firestore rules enforce this independently of what this screen offers.
 */
export default function Collections() {
  const { fiscalYear, fundCode, period } = useFilters();
  const { can } = useAuth();
  const toast = useToast();
  const { data, loading, error } = useCollections(fiscalYear, fundCode);

  const [showForm, setShowForm] = useState(false);
  const [offlineSetup, setOfflineSetup] = useState(false);
  /* The receipt being corrected, if any. See collectionEditable. */
  const [editing, setEditing] = useState<Collection | null>(null);
  /* The receipt being READ. The row opens this; the detail offers the edit. */
  const [viewing, setViewing] = useState<Collection | null>(null);
  const [source, setSource] = useState('');

  /*
   * Patch 158: "Receipt the refund" on a payroll comes here with
   * ?refundOf=<payroll>. The form opens with the officer as payor and one
   * line: Advances for Payroll, in the officer's subsidiary account, for the
   * refund the payroll declared.
   */
  const [params, setParams] = useSearchParams();
  const refundOf = params.get('refundOf');
  const refundPayroll = useDocument<PayrollRecord>(refundOf ? COL.payrolls : null, refundOf);
  const [refundPrefill, setRefundPrefill] = useState<RefundPrefill | null>(null);
  useEffect(() => {
    if (!refundOf || !refundPayroll.data) return;
    const receipted = data
      .filter((c) => c.refundForPayrollId === refundOf && c.status !== 'CANCELLED')
      .reduce((sum, c) => sum + (c.totalAmount ?? 0), 0);
    const draft = refundReceiptDraft(refundPayroll.data, ADVANCES_FOR_PAYROLL, receipted);
    if (draft) {
      setRefundPrefill(draft);
      setShowForm(true);
    }
    const next = new URLSearchParams(params);
    next.delete('refundOf');
    setParams(next, { replace: true });
  }, [refundOf, refundPayroll.data, data, params, setParams]);

  /*
   * The counter's own receipts, and only those.
   *
   * An e-collection is a `collections` document like any other - that is the
   * decision the e-collection work rests on, and the reasons are written out
   * on `Collection.eCollectionKind`. The cost of it is exactly here: two
   * screens read one register, so each has to show its own half or the day's
   * takings read twice. This screen shows what came over the counter; the
   * e-Collections tab shows what arrived electronically.
   */
  const rows = useMemo(
    () =>
      data
        .filter((c) => !c.eCollectionKind)
        .filter((c) => !period || Number(c.orDate?.slice(5, 7)) === period)
        .filter((c) => !source || c.revenueSource === source),
    [data, period, source],
  );

  const total = rows.filter((c) => c.status !== 'CANCELLED').reduce((s, c) => s + c.totalAmount, 0);
  const undeposited = rows
    .filter((c) => ['ISSUED', 'IN_RCD'].includes(c.status))
    .reduce((s, c) => s + c.totalAmount, 0);

  /*
   * Receipts written before CFMS asked for the detail.
   *
   * They cannot be put right by re-issuing the receipt - the paper is with
   * the taxpayer. The point of showing them is that somebody in the office
   * may still remember which barangay the land was in, or which programme
   * the money came under, and that memory has a short life. Left unsaid,
   * these are discovered when the abstract is drawn and the figures do not
   * add up to the collection report.
   */
  const incomplete = useMemo(() => rows.filter((c) => receiptIsIncomplete(c)), [rows]);

  /* Patch 160: the remittances, applied to the receipts in AF series order. */
  const remittances = useRemittances(fiscalYear, fundCode);
  const remitted = useMemo(
    () => allocateRemittances(data as never, remittances.data as never),
    [data, remittances.data],
  );

  const columns: Column<Collection>[] = [
    {
      key: 'orNumber',
      header: 'OR No.',
      width: '8rem',
      value: (c) => c.orNumber,
      cell: (c) => <span className="font-mono text-xs text-navy-900">{c.orNumber}</span>,
    },
    {
      key: 'orDate',
      header: 'Date',
      kind: 'date',
      width: '7rem',
      value: (c) => c.orDate,
      cell: (c) => <span className="text-xs">{formatShortDate(c.orDate)}</span>,
    },
    {
      key: 'payor',
      header: 'Payor',
      value: (c) => c.payorName,
      cell: (c) => <span className="text-sm">{c.payorName}</span>,
    },
    {
      key: 'source',
      header: 'Revenue source',
      value: (c) => c.revenueSource,
      cell: (c) => (
        <span className="text-xs text-slate-600">
          {REVENUE_SOURCES.find((s) => s.value === c.revenueSource)?.label ?? c.revenueSource}
        </span>
      ),
    },
    {
      key: 'particulars',
      header: 'Particulars',
      value: (c) => c.remarks ?? c.lines?.[0]?.particulars ?? '',
      cell: (c) => {
        const text = c.remarks ?? c.lines?.[0]?.particulars ?? '';
        return text ? (
          <span className="text-xs text-slate-600">{text}</span>
        ) : (
          <span className="text-xs text-slate-400">&mdash;</span>
        );
      },
      optional: true,
    },
    {
      key: 'officer',
      header: 'Collecting officer',
      value: (c) => c.collectingOfficerName,
      cell: (c) => <span className="text-xs text-slate-600">{c.collectingOfficerName}</span>,
      optional: true,
    },
    {
      key: 'form',
      header: 'Form',
      width: '6rem',
      value: (c) => c.paymentForm,
      cell: (c) => <span className="text-xs">{c.paymentForm}</span>,
      optional: true,
    },
    {
      key: 'amount',
      header: 'Amount',
      kind: 'amount',
      value: (c) => c.totalAmount,
      cell: (c) => formatPeso(c.totalAmount, { symbol: false }),
    },
    {
      key: 'rcd',
      header: 'RCD',
      width: '9rem',
      value: (c) => c.rcdNo ?? '',
      cell: (c) => <span className="font-mono text-xs text-slate-500">{c.rcdNo ?? '-'}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      width: '8rem',
      value: (c) => c.status,
      cell: (c) => <StatusBadge status={c.status} />,
    },
    {
      // Patch 160: turned over to the Liquidating Officer yet? See Remittances.
      key: 'remitted',
      header: 'Remitted',
      width: '8rem',
      value: (c) => remitted.byReceipt.get(c.id)?.state ?? '',
      cell: (c) => {
        const a = remitted.byReceipt.get(c.id);
        if (!a) return <span className="text-slate-400">-</span>;
        return a.state === 'REMITTED' ? (
          <span className="text-xs text-emerald-700">Remitted</span>
        ) : a.state === 'PARTIAL' ? (
          <span className="text-xs text-amber-700">
            Part - {formatPeso(a.unremitted, { symbol: false })} due
          </span>
        ) : (
          <span className="text-xs text-rose-700">Not yet</span>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="Collections and Deposits"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}${period ? `, ${monthName(period)}` : ''} - ${formatPeso(total)} collected`}
        breadcrumbs={COLLECTION_CRUMBS}
        actions={
          can('treasury', 'create') && (
            <>
              {/* Patch 156: bulk upload of collections. */}
              <Link to="/treasury/collections/upload">
                <Button size="sm">Bulk upload</Button>
              </Link>
              {/* Patch 173: the setup file for the offline Collections app. */}
              <Button size="sm" onClick={() => setOfflineSetup(true)}>
                Offline app setup
              </Button>
              <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
                Record collection
              </Button>
            </>
          )
        }
      />

      <GroupedSectionTabs groups={COLLECTION_TAB_GROUPS} />

      {offlineSetup && <OfflineSetupDownload onClose={() => setOfflineSetup(false)} />}

      {incomplete.length > 0 && (
        <Alert
          tone="warning"
          className="mb-4"
          title={`${incomplete.length} receipt${incomplete.length === 1 ? '' : 's'} recorded without the detail the reports need`}
        >
          <p>
            A real property tax collection needs its tax year, and the basic tax needs the
            barangay the property is in; a Trust Fund collection needs its programme. These were
            optional until now, so these {incomplete.length === 1 ? 'receipt was' : 'receipts were'}{' '}
            saved without them, and {incomplete.length === 1 ? 'it' : 'they'} will not appear
            correctly in the Abstract of Real Property Tax Collections or the Fund Utilization
            Report.
          </p>
          <p className="mt-2 font-mono text-xs">
            {incomplete.slice(0, 20).map((c) => c.orNumber).join(', ')}
            {incomplete.length > 20 ? ` and ${incomplete.length - 20} more` : ''}
          </p>
          <p className="mt-2 text-xs">
            The receipt itself cannot be amended - the paper is with the taxpayer. Record the
            correction the way the office normally would, while somebody still remembers which
            barangay or which programme each one was.
          </p>
        </Alert>
      )}

      {undeposited > 0 && (
        <Alert tone="warning" className="mb-4" title="Undeposited collections">
          {formatPeso(undeposited)} has been collected but not yet deposited. Collections should be
          deposited intact and daily. Record the deposit slip under the Deposits tab.
        </Alert>
      )}

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(c) => c.id}
        onRowClick={(c) => setViewing(c)}
        loading={loading}
        error={error}
        searchPlaceholder="OR number, payor or collecting officer"
        emptyTitle="No collections recorded"
        emptyMessage="Record official receipts as they are issued."
        filters={
          <Select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="w-auto py-1.5 text-sm"
            aria-label="Revenue source"
          >
            <option value="">All revenue sources</option>
            {REVENUE_SOURCES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        }
        printLayout="landscape"
        exportMeta={{
          title: 'Revenue Collection Report',
          fundLabel: fundLabel(fundCode),
          periodLabel: period
            ? `For the month of ${monthName(period)} ${fiscalYear}`
            : `For the fiscal year ${fiscalYear}`,
        }}
        totals={{
          label: `Total - ${rows.filter((c) => c.status !== 'CANCELLED').length} receipts`,
          values: { amount: formatPeso(total, { symbol: false }) },
        }}
      />

      {viewing && (
        <CollectionDetail
          collection={viewing}
          canEdit={can('treasury', 'create')}
          onEdit={() => {
            setEditing(viewing);
            setViewing(null);
          }}
          onClose={() => setViewing(null)}
        />
      )}

      {editing && (
        <CollectionForm
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={(orNumber) => {
            setEditing(null);
            toast.success('Receipt corrected', `${orNumber} has been updated.`);
          }}
        />
      )}

      {showForm && (
        <CollectionForm
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          prefill={refundPrefill}
          onClose={() => {
            setShowForm(false);
            setRefundPrefill(null);
          }}
          onSaved={(orNumber) => {
            setShowForm(false);
            setRefundPrefill(null);
            toast.success(`Official Receipt ${orNumber} recorded`);
          }}
        />
      )}
    </div>
  );
}

function CollectionForm({
  fiscalYear,
  fundCode,
  existing,
  prefill,
  onClose,
  onSaved,
}: {
  fiscalYear: number;
  fundCode: string;
  /**
   * The receipt being corrected, where one is.
   *
   * The same form records and corrects, deliberately. A separate edit screen
   * is a second place for the rules about what a receipt needs - the tax year,
   * the barangay, the trust programme - and the one that gets forgotten is the
   * edit screen, so corrections quietly become the way to save a receipt that
   * the recording screen would have refused.
   */
  existing?: Collection | null;
  /** Patch 158: a new receipt started from a payroll's refund. */
  prefill?: RefundPrefill | null;
  onClose: () => void;
  onSaved: (orNumber: string) => void;
}) {
  const toast = useToast();
  const { user, profile } = useAuth();

  /*
   * The Trust Fund's money arrived for a stated purpose, and the programme is
   * what names it. Asked for on the receipt itself, because the receipt is the
   * only moment anyone knows which programme the payor is remitting against -
   * by the time the registry is read, the answer is a phone call away.
   *
   * Only on the Trust Fund: no other fund has programmes.
   */
  const isTrust = fundCode === TRUST_FUND_CODE;
  const programs = useTrustPrograms();
  /* The barangays, for the share that follows the property. */
  const barangays = useBarangays();

  const [orNumber, setOrNumber] = useState(existing?.orNumber ?? '');
  /*
   * Patch 161: the accountable form the receipt was written on - its Type
   * (Form No.) on the RCD, and the booklet Section C accounts for.
   */
  const [formCode, setFormCode] = useState<string>(
    (existing as { accountableForm?: string } | null | undefined)?.accountableForm ??
      (existing as { accountableFormId?: string } | null | undefined)?.accountableFormId ??
      '',
  );
  const formTypes = useAccountableFormTypes();
  const movementsNow = useFormMovements(fiscalYear);
  const movementsBefore = useFormMovements(fiscalYear - 1);
  const [orDate, setOrDate] = useState(existing?.orDate ?? todayPh());
  const [officerId, setOfficerId] = useState<string | null>(existing?.collectingOfficerId ?? null);
  const [officerName, setOfficerName] = useState(existing?.collectingOfficerName ?? '');
  const [payorName, setPayorName] = useState(existing?.payorName ?? prefill?.payorName ?? '');
  const [payorTin, setPayorTin] = useState(existing?.payorTin ?? '');
  const [revenueSource, setRevenueSource] = useState<RevenueSource>(
    existing?.revenueSource ?? 'FEES_AND_CHARGES',
  );
  const [paymentForm, setPaymentForm] = useState<'CASH' | 'CHECK' | 'ONLINE' | 'CARD'>(
    existing?.paymentForm ?? 'CASH',
  );
  /*
   * What the money was for, in the collecting officer's words.
   *
   * The receipt already carries the revenue ACCOUNT, which says how it is
   * classified - and that is not the same as what it was for. "Business Taxes"
   * does not distinguish a mayor's permit from a renewal, and the Abstract of
   * General Collection and the Cashbook both print a particulars column that
   * was coming out blank on every cash receipt.
   */
  const [particulars, setParticulars] = useState(
    existing?.remarks ?? existing?.lines?.[0]?.particulars ?? prefill?.particulars ?? '',
  );
  const [checkNo, setCheckNo] = useState(existing?.checkNo ?? '');
  const [lines, setLines] = useState<Array<Partial<CollectionLine>>>(
    existing?.lines?.length
      ? existing.lines.map((l) => ({ ...l }))
      : prefill
        ? prefill.lines.map((l) => ({ ...l }))
        : [{ lineNo: 1 }],
  );
  const [saving, setSaving] = useState(false);
  /* Patch 158: the chart, to know which lines are kept per party. */
  const accounts = useAccounts(true);
  const accountOf = (code: string) => accounts.data.find((a) => a.code === code) ?? null;

  const total = useMemo(() => lines.reduce((s, l) => s + (l.amount ?? 0), 0), [lines]);

  /*
   * The tax year and barangay column appears only once a real property tax
   * account is on the receipt. Showing it on every collection would put two
   * empty boxes beside every permit fee in the municipality.
   */
  const anyRpt = useMemo(() => lines.some((l) => isRptAccount(l.accountCode ?? '')), [lines]);

  const save = async () => {
    if (!orNumber.trim() || !officerId || !payorName.trim() || total <= 0 || !user) {
      toast.error('Incomplete', 'OR number, collecting officer, payor and at least one amount are required.');
      return;
    }

    /*
     * The detail the reports are built from, asked for now.
     *
     * These were optional dropdowns reading "Year not stated" and "Barangay
     * not stated", and that is what a busy counter leaves them on. The cost
     * lands months later on whoever produces the Abstract of Real Property
     * Tax Collections, by which time the receipt is issued, the paper is with
     * the taxpayer, and the only person who knew which barangay the land was
     * in has forgotten. Here it costs one question to the taxpayer standing
     * at the counter.
     */
    const problems = receiptDetailProblems(lines, fundCode);
    if (problems.length > 0) {
      toast.error('The receipt is missing detail the reports need', describeProblems(problems));
      return;
    }
    // Patch 158: a receivable, a payable, or a revenue account kept per party
    // names its subsidiary ledger account.
    const noSub = missingSubsidiaries(lines, accountOf);
    if (noSub.length > 0) {
      toast.error(
        'Choose the subsidiary ledger account',
        `The account on ${noSub.join(', ')} is kept per party: say whose account it is.`,
      );
      return;
    }
    // Patch 156: particulars are required on every entry.
    if (!particulars.trim()) {
      toast.error('Particulars are required', 'Say what this entry is for - it is printed on the reports.');
      return;
    }
    /*
     * Patch 161: the receipt must be on a form the collecting officer holds -
     * issued to them, not yet returned, spoiled or cancelled, on that date.
     */
    if (!formCode) {
      toast.error('Which accountable form?', 'Choose the accountable form (Type / Form No.) the receipt was written on.');
      return;
    }
    {
      const held = officerHoldings(
        [...movementsBefore.data, ...movementsNow.data] as never,
        officerId,
        formCode,
        orDate,
      );
      if (!holdsSerial(held, orNumber.trim())) {
        const t = formTypes.data.find((x) => normaliseFormCode(x.code) === normaliseFormCode(formCode));
        toast.error(
          'That receipt was not issued to this collector',
          `${t?.printedAs ?? formCode} No. ${orNumber.trim()} is not in any booklet issued to ${officerName || 'the collecting officer'} as at ${orDate}. Issue the booklet to them first (Treasury > Accountable Forms > Issue), or check the receipt number and the form.`,
        );
        return;
      }
    }
    setSaving(true);
    try {
      const payload = {
          fiscalYear,
          period: Number(orDate.slice(5, 7)),
          fundCode,
          orNumber: orNumber.trim().toUpperCase(),
          orDate,
          // Patch 161: Type (Form No.) - the RCD's Section A.1 and C read it.
          accountableForm: formCode,
          accountableFormId: formCode,
          collectingOfficerId: officerId,
          collectingOfficerName: officerName,
          revenueSource,
          payorName: payorName.trim(),
          payorTin: payorTin.trim() || null,
          lines: lines.map((l, i) => ({
            lineNo: i + 1,
            accountCode: l.accountCode ?? '',
            accountName: l.accountName ?? '',
            amount: l.amount ?? 0,
            // The line's own wording where it has one, the receipt's
            // otherwise - so a one-account receipt need not be typed twice.
            particulars: l.particulars ?? (particulars.trim() || null),
            // Trust Fund only. A programme on a General Fund receipt would be
            // a mistake, and the server ignores it rather than acting on it.
            trustProgramId: isTrust ? (l.trustProgramId ?? null) : null,
            trustProgramName: isTrust ? (l.trustProgramName ?? null) : null,
            // Real property tax only. A tax year or a barangay on a permit fee
            // would be noise the abstract then has to ignore.
            rptTaxYear: isRptAccount(l.accountCode ?? '') ? (l.rptTaxYear ?? null) : null,
            barangayId: isRptAccount(l.accountCode ?? '') ? (l.barangayId ?? null) : null,
            barangayName: isRptAccount(l.accountCode ?? '') ? (l.barangayName ?? null) : null,
            // Patch 158: the subsidiary ledger account, where the line has one.
            subsidiaryType: l.subsidiaryId ? (l.subsidiaryType ?? null) : null,
            subsidiaryId: l.subsidiaryId ?? null,
            subsidiaryName: l.subsidiaryId ? (l.subsidiaryName ?? null) : null,
          })),
          totalAmount: total,
          paymentForm,
          checkNo: paymentForm === 'CHECK' ? checkNo.trim() || null : null,
          remarks: particulars.trim() || null,
      };

      const stamp = actorStamp({
        uid: user.uid,
        name: profile?.displayName ?? user.email ?? user.uid,
        position: profile?.position,
      });

      if (existing) {
        /*
         * The STATUS is not in the payload when correcting.
         *
         * A receipt that has been banked is DEPOSITED, and writing 'ISSUED'
         * back over it while fixing a payor's name would un-bank it - the
         * money would reappear in "awaiting deposit" and the deposit would
         * point at a receipt that no longer agreed it had been deposited.
         */
        await updateDraft(COL.collections, existing.id, payload, stamp);
      } else {
        await createDraft(
          COL.collections,
          {
            ...payload,
            status: 'ISSUED',
            // Patch 158: the payroll whose refund this receipts.
            ...(prefill
              ? { refundForPayrollId: prefill.payrollId, refundForPayrollNo: prefill.payrollNo }
              : {}),
          },
          stamp,
        );
      }
      onSaved(orNumber.trim().toUpperCase());
    } catch (err) {
      toast.error('Could not record the collection', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={existing ? `Correct receipt ${existing.orNumber}` : 'Record a collection'}
      description={
        existing
          ? 'Correcting the ENCODING of a receipt, not the receipt itself. The paper is with the taxpayer; if the paper is wrong it is cancelled and reissued.'
          : 'One official receipt, with its revenue account distribution.'
      }
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            {existing ? 'Save the correction' : 'Record'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Accountable form" required htmlFor="orForm">
          <Select id="orForm" value={formCode} onChange={(e) => setFormCode(e.target.value)}>
            <option value="">Type (Form No.)</option>
            {formTypes.data.map((t) => (
              <option key={t.id} value={t.code}>
                {t.printedAs || t.name} ({t.code})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="OR number" required htmlFor="orNo">
          <TextInput
            id="orNo"
            value={orNumber}
            onChange={(e) => setOrNumber(e.target.value)}
            className="font-mono"
            placeholder="0001234"
          />
        </Field>
        <Field label="Date" required htmlFor="orDate">
          <DateInput id="orDate" value={orDate} onChange={setOrDate} />
        </Field>
        <Field label="Collecting officer" required htmlFor="officer">
          <EmployeePicker
            id="officer"
            value={officerId}
            onChange={(v, emp) => {
              setOfficerId(v);
              setOfficerName(emp?.name ?? '');
            }}
          />
        </Field>

        <Field label="Payor" required htmlFor="payor" className="sm:col-span-2">
          <TextInput id="payor" value={payorName} onChange={(e) => setPayorName(e.target.value)} />
        </Field>
        <Field label="Payor TIN" htmlFor="payorTin">
          <TextInput id="payorTin" value={payorTin} onChange={(e) => setPayorTin(e.target.value)} />
        </Field>

        <Field label="Revenue source" htmlFor="source">
          <Select id="source" value={revenueSource} onChange={(e) => setRevenueSource(e.target.value as RevenueSource)}>
            {REVENUE_SOURCES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Form of payment" htmlFor="form">
          <Select
            id="form"
            value={paymentForm}
            onChange={(e) => setPaymentForm(e.target.value as typeof paymentForm)}
          >
            <option value="CASH">Cash</option>
            <option value="CHECK">Check</option>
            <option value="ONLINE">Online transfer</option>
            <option value="CARD">Card</option>
          </Select>
        </Field>
        {paymentForm === 'CHECK' && (
          <Field label="Check number" htmlFor="ckNo">
            <TextInput id="ckNo" value={checkNo} onChange={(e) => setCheckNo(e.target.value)} className="font-mono" />
          </Field>
        )}

        <Field label="Particulars" required htmlFor="particulars" className="sm:col-span-3">
          <TextInput
            id="particulars"
            value={particulars}
            onChange={(e) => setParticulars(e.target.value)}
            placeholder="What the payment was for, as it should read on the reports"
          />
        </Field>
      </div>

      <div className="mt-5">
        <p className="cbo-label">Accounts</p>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="cbo-th min-w-[18rem]">Account</th>
              {isTrust && <th className="cbo-th min-w-[16rem]">Trust programme</th>}
              {anyRpt && <th className="cbo-th min-w-[18rem]">Tax year and barangay</th>}
              <th className="cbo-th cbo-amount-col">Amount</th>
              <th className="cbo-th w-8" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={index}>
                <td className="cbo-td">
                  <AccountPicker
                    value={line.accountCode ?? null}
                    onChange={(code, account) =>
                      setLines((ls) =>
                        ls.map((l, i) =>
                          i === index
                            ? {
                                ...l,
                                accountCode: code ?? undefined,
                                accountName: account?.name,
                                // Patch 158: a new account, a new subsidiary.
                                ...(code !== l.accountCode
                                  ? { subsidiaryType: null, subsidiaryId: null, subsidiaryName: null }
                                  : {}),
                              }
                            : l,
                        ),
                      )
                    }
                  />
                  <LineSubsidiary
                    accountCode={line.accountCode}
                    account={accountOf(line.accountCode ?? '')}
                    fundCode={fundCode}
                    value={line}
                    onChange={(sub) =>
                      setLines((ls) => ls.map((l, i) => (i === index ? { ...l, ...sub } : l)))
                    }
                  />
                </td>
                {isTrust && (
                  <td className="cbo-td">
                    <Select
                      value={line.trustProgramId ?? ''}
                      onChange={(e) => {
                        const id = e.target.value || undefined;
                        const chosen = programs.data.find((pr) => pr.id === id);
                        setLines((ls) =>
                          ls.map((l, i) =>
                            i === index
                              ? { ...l, trustProgramId: id, trustProgramName: chosen?.programName }
                              : l,
                          ),
                        );
                      }}
                    >
                      <option value="">Which programme?</option>
                      {programs.data
                        .filter((pr) => pr.status === 'ACTIVE')
                        .map((pr) => (
                          <option key={pr.id} value={pr.id}>
                            {pr.programCode} - {pr.programName}
                          </option>
                        ))}
                    </Select>
                  </td>
                )}
                {anyRpt && (
                  <td className="cbo-td">
                    {isRptAccount(line.accountCode ?? '') ? (
                      <div className="flex gap-2">
                        <Select
                          value={line.rptTaxYear ?? ''}
                          onChange={(e) =>
                            setLines((ls) =>
                              ls.map((l, i) =>
                                i === index
                                  ? { ...l, rptTaxYear: (e.target.value || undefined) as 'CURRENT' | 'PRECEDING' | undefined }
                                  : l,
                              ),
                            )
                          }
                        >
                          <option value="">Which tax year?</option>
                          <option value="CURRENT">Current year</option>
                          <option value="PRECEDING">Preceding year</option>
                        </Select>

                        {/* Only the basic tax is shared with the barangays:
                            the Special Education Fund is divided equally
                            between the two school boards and the barangays
                            have no part of it. */}
                        {sharesWithBarangay(line.accountCode ?? '') && (
                          <Select
                            value={line.barangayId ?? ''}
                            onChange={(e) => {
                              const id = e.target.value || undefined;
                              const chosen = barangays.data.find((b) => b.id === id);
                              setLines((ls) =>
                                ls.map((l, i) =>
                                  i === index
                                    ? { ...l, barangayId: id, barangayName: chosen?.name }
                                    : l,
                                ),
                              );
                            }}
                          >
                            <option value="">Which barangay?</option>
                            {barangays.data.map((b) => (
                              <option key={b.id} value={b.id}>
                                {b.name}
                              </option>
                            ))}
                          </Select>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">&mdash;</span>
                    )}
                  </td>
                )}
                <td className="cbo-td">
                  <AmountInput
                    value={line.amount ?? null}
                    onChange={(v) => setLines((ls) => ls.map((l, i) => (i === index ? { ...l, amount: v ?? 0 } : l)))}
                    className="py-1.5"
                  />
                </td>
                <td className="cbo-td text-center">
                  <button
                    onClick={() => setLines((ls) => ls.filter((_, i) => i !== index))}
                    disabled={lines.length <= 1}
                    className="rounded p-1 text-slate-400 hover:text-rose-600 disabled:opacity-30"
                    aria-label="Remove line"
                  >
                    &times;
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-slate-50 font-medium">
              <td className="cbo-td" colSpan={1 + (isTrust ? 1 : 0) + (anyRpt ? 1 : 0)}>
                Total collected
              </td>
              <td className="cbo-td cbo-amount font-semibold">{formatPeso(total, { symbol: false })}</td>
              <td className="cbo-td" />
            </tr>
          </tfoot>
        </table>

        <Button size="sm" className="mt-3" onClick={() => setLines((ls) => [...ls, { lineNo: ls.length + 1 }])}>
          Add account
        </Button>
      </div>
    </Modal>
  );
}
