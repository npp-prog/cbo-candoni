import { Link } from 'react-router-dom';
import { useMemo, useState } from 'react';
import { PageHeader, Alert } from '@/components/ui/Layout';
import { GroupedSectionTabs } from '@/components/ui/SectionTabs';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Field, Select, DateInput, AmountInput, TextInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { AccountPicker, EmployeePicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import {
  useBarangays,
  useCollections,
  useIntermediaries,
  useOffices,
  useTrustPrograms,
} from '@/data/queries';
import { createDraft, updateDraft, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { formatPeso } from '@/lib/money';
import { TRUST_FUND_CODE } from '@/lib/trustPrograms';
import { isRptAccount, sharesWithBarangay } from '@/pages/reports/rptAbstractReport';
import { receiptDetailProblems, describeProblems } from '@/lib/receiptDetail';
import { formatShortDate, monthName, todayPh } from '@/lib/dates';
import { REVENUE_SOURCES } from '@/types/treasury';
import type { Collection, CollectionLine, RevenueSource } from '@/types/treasury';
import { fundLabel } from '../budget/Obligations';
import { COLLECTION_TAB_GROUPS, COLLECTION_CRUMBS } from './sections';
import { CollectionDetail } from './CollectionDetail';
import {
  E_COLLECTION_KINDS,
  eCollectionKind,
  type ECollectionKind,
} from './eCollectionKinds';

/**
 * e-Collections - money that arrived without anybody handing cash over a
 * counter.
 *
 * ---------------------------------------------------------------------------
 * THIS SCREEN WRITES ORDINARY COLLECTIONS
 * ---------------------------------------------------------------------------
 * Every record it creates is a `collections` document, exactly like one raised
 * at the counter, carrying one extra field: which of COA Circular 2021-014's
 * three reports it belongs on. The reasoning is written out in full on
 * `Collection.eCollectionKind` and it is the decision the whole patch rests on
 * - online money hits the same revenue accounts, is deposited to the same bank
 * and must appear in the same Cashbook, Abstract and SRE as the cash.
 *
 * So the Collections screen and this one are two doors into one register, and
 * each shows only its own half. If they ever showed both, the day's takings
 * would read twice.
 */
export default function ECollections() {
  const { fiscalYear, fundCode, period } = useFilters();
  const { can } = useAuth();
  const toast = useToast();
  const { data, loading, error } = useCollections(fiscalYear, fundCode);

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Collection | null>(null);
  /* The receipt being READ. The row opens this; the detail offers the edit. */
  const [viewing, setViewing] = useState<Collection | null>(null);
  const [kindFilter, setKindFilter] = useState('');

  const rows = useMemo(
    () =>
      data
        .filter((c) => !!c.eCollectionKind)
        .filter((c) => !period || Number(c.orDate?.slice(5, 7)) === period)
        .filter((c) => !kindFilter || c.eCollectionKind === kindFilter),
    [data, period, kindFilter],
  );

  const total = rows.filter((c) => c.status !== 'CANCELLED').reduce((s, c) => s + c.totalAmount, 0);
  const unreported = rows
    .filter((c) => c.status !== 'CANCELLED' && !c.treasuryReportId)
    .reduce((s, c) => s + c.totalAmount, 0);

  const columns: Column<Collection>[] = [
    {
      key: 'kind',
      header: 'Kind',
      width: '5rem',
      value: (c) => c.eCollectionKind ?? '',
      cell: (c) => (
        <span className="text-xs font-medium text-navy-900">
          {c.eCollectionKind === 'DIRECT' ? 'Direct' : c.eCollectionKind}
        </span>
      ),
    },
    {
      key: 'receiptNo',
      header: 'Receipt / reference',
      width: '11rem',
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
      key: 'intermediary',
      header: 'Intermediary',
      value: (c) => c.intermediaryName ?? '',
      cell: (c) =>
        c.intermediaryName ? (
          <span className="text-xs text-slate-600">{c.intermediaryName}</span>
        ) : (
          // Annex G has no intermediary: the payor paid the bank itself.
          <span className="text-xs text-slate-400">Paid to the bank</span>
        ),
    },
    {
      key: 'payor',
      header: 'Payor',
      value: (c) => c.payorName,
      cell: (c) => <span className="text-sm">{c.payorName}</span>,
    },
    {
      key: 'rcc',
      header: 'Resp. centre',
      width: '7rem',
      value: (c) => c.responsibilityCenterCode ?? '',
      cell: (c) => <span className="font-mono text-xs text-slate-600">{c.responsibilityCenterCode ?? '—'}</span>,
      optional: true,
    },
    {
      key: 'amount',
      header: 'Amount',
      kind: 'amount',
      value: (c) => c.totalAmount,
      cell: (c) => <span className="cbo-amount text-sm">{formatPeso(c.totalAmount, { symbol: false })}</span>,
    },
    {
      key: 'report',
      header: 'Reported on',
      width: '9rem',
      value: (c) => c.treasuryReportNo ?? '',
      cell: (c) =>
        c.treasuryReportNo ? (
          <span className="font-mono text-xs text-slate-600">{c.treasuryReportNo}</span>
        ) : (
          <span className="text-xs text-slate-400">Not yet reported</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '7rem',
      value: (c) => c.status,
      // Patch 156: an e-collection is presented as deposited - it was
      // credited straight to the bank account.
      cell: (c) =>
        c.status === 'CANCELLED' ? (
          <StatusBadge status={c.status} />
        ) : (
          <StatusBadge status="DEPOSITED" label="Deposited" />
        ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="e-Collections"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}${period ? `, ${monthName(period)}` : ''} - ${formatPeso(total)} received electronically`}
        breadcrumbs={COLLECTION_CRUMBS}
        actions={
          can('treasury', 'create') && (
            <>
              {/* Patch 156: bulk upload of e-collections. */}
              <Link to={`/treasury/collections/upload?kind=${kindFilter || 'EOR'}`}>
                <Button size="sm">Bulk upload</Button>
              </Link>
              <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
                Record an e-collection
              </Button>
            </>
          )
        }
      />

      <GroupedSectionTabs groups={COLLECTION_TAB_GROUPS} />

      <div className="mb-3 flex flex-wrap gap-6 text-sm">
        <span className="text-slate-600">
          Recorded: <span className="cbo-amount font-semibold text-navy-900">{formatPeso(total)}</span>
        </span>
        <span className="text-slate-600">
          Not yet on a report:{' '}
          <span className="cbo-amount font-semibold text-amber-700">{formatPeso(unreported)}</span>
        </span>

      </div>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(c) => c.id}
        onRowClick={(c) => setViewing(c)}
        loading={loading}
        error={error}
        searchPlaceholder="Receipt number, payor or intermediary"
        /*
          Patch 156: eOR / AR as a dropdown beside the table's own buttons,
          not as two cards above it. The choice of kind - and what each means -
          is made in the form when a receipt is recorded.
        */
        filters={
          <Select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
            className="w-auto py-1.5 text-sm"
            aria-label="Kind of e-collection"
          >
            <option value="">eOR and AR</option>
            {E_COLLECTION_KINDS.map((k) => (
              <option key={k.kind} value={k.kind} title={k.when}>
                {k.label}
              </option>
            ))}
          </Select>
        }
        emptyTitle="No e-collections recorded"
        emptyMessage="Record each electronic receipt as the intermediary's list or the proof of deposit comes in."
        exportMeta={{
          title: 'Report of e-Collections and Deposits',
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
        <ECollectionForm
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          existing={data}
          editingRecord={editing}
          onClose={() => setEditing(null)}
          onSaved={(no) => {
            setEditing(null);
            toast.success('e-Collection corrected', `${no} has been updated.`);
          }}
        />
      )}

      {showForm && (
        <ECollectionForm
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          existing={data}
          onClose={() => setShowForm(false)}
          onSaved={(no) => {
            setShowForm(false);
            toast.success('e-Collection recorded', `${no} has been added to the register.`);
          }}
        />
      )}
    </div>
  );
}

function ECollectionForm({
  fiscalYear,
  fundCode,
  existing,
  editingRecord,
  onClose,
  onSaved,
}: {
  fiscalYear: number;
  fundCode: string;
  /** Every collection of the year, for the duplicate-number check. */
  existing: Collection[];
  /** The record being corrected, where one is. */
  editingRecord?: Collection | null;
  onClose: () => void;
  onSaved: (receiptNo: string) => void;
}) {
  const toast = useToast();
  const { user, profile } = useAuth();

  const isTrust = fundCode === TRUST_FUND_CODE;
  const programs = useTrustPrograms();
  const barangays = useBarangays();
  const intermediaries = useIntermediaries();
  const offices = useOffices();

  const [kind, setKind] = useState<ECollectionKind>(
    (editingRecord?.eCollectionKind as ECollectionKind) ?? 'EOR',
  );
  const spec = eCollectionKind(kind)!;

  const [receiptNo, setReceiptNo] = useState(editingRecord?.orNumber ?? '');
  const [receiptDate, setReceiptDate] = useState(editingRecord?.orDate ?? todayPh());
  const [officerId, setOfficerId] = useState<string | null>(
    editingRecord?.collectingOfficerId ?? null,
  );
  const [officerName, setOfficerName] = useState(editingRecord?.collectingOfficerName ?? '');
  const [intermediaryId, setIntermediaryId] = useState(editingRecord?.intermediaryId ?? '');
  const [responsibilityCenterCode, setResponsibilityCenterCode] = useState(
    editingRecord?.responsibilityCenterCode ?? '',
  );
  const [prexcPap, setPrexcPap] = useState(editingRecord?.prexcPap ?? '');
  const [payorName, setPayorName] = useState(editingRecord?.payorName ?? '');
  const [payorTin, setPayorTin] = useState(editingRecord?.payorTin ?? '');
  const [revenueSource, setRevenueSource] = useState<RevenueSource>(
    editingRecord?.revenueSource ?? 'FEES_AND_CHARGES',
  );
  const [particulars, setParticulars] = useState(
    editingRecord?.remarks ?? editingRecord?.lines?.[0]?.particulars ?? '',
  );
  const [lines, setLines] = useState<Array<Partial<CollectionLine>>>(
    editingRecord?.lines?.length ? editingRecord.lines.map((l) => ({ ...l })) : [{ lineNo: 1 }],
  );
  const [saving, setSaving] = useState(false);

  const total = useMemo(() => lines.reduce((s, l) => s + (l.amount ?? 0), 0), [lines]);
  const anyRpt = useMemo(() => lines.some((l) => isRptAccount(l.accountCode ?? '')), [lines]);

  /**
   * The number is typed, so CFMS has to refuse one it has seen.
   *
   * An eOR number is random and an AR number comes out of the intermediary's
   * system; neither is drawn from a series CFMS controls, so nothing stops the
   * same number being encoded twice except looking. Two records of one receipt
   * is two collections in the ledger, and the only trace it left would be a
   * bank balance that would not reconcile.
   *
   * Checked across the WHOLE year rather than the open period: a receipt
   * re-encoded a month later is exactly the case a period-scoped check misses.
   * The comparison is case- and space-insensitive, because "GC-0012" typed as
   * "gc 0012" is the same receipt to everybody except a string comparison.
   */
  const normalise = (n: string) => n.trim().toUpperCase().replace(/\s+/g, '');
  const duplicate = useMemo(() => {
    const wanted = normalise(receiptNo);
    if (!wanted) return null;
    return (
      existing.find(
        (c) =>
          c.id !== editingRecord?.id &&
          c.status !== 'CANCELLED' &&
          normalise(c.orNumber ?? '') === wanted,
      ) ?? null
    );
  }, [existing, receiptNo, editingRecord?.id]);

  const save = async () => {
    if (!receiptNo.trim() || !officerId || !payorName.trim() || total <= 0 || !user) {
      toast.error(
        'Incomplete',
        `${spec.numberLabel}, the officer, the payor and at least one amount are required.`,
      );
      return;
    }
    if (spec.withIntermediary && !intermediaryId) {
      toast.error(
        'The intermediary is missing',
        'Annexes E and F name the intermediary on the face of the report. Add it under Master Data > Collection Intermediaries if it is not in the list.',
      );
      return;
    }
    if (duplicate) {
      toast.error(
        'That number is already recorded',
        `${duplicate.orNumber} was recorded on ${formatShortDate(duplicate.orDate)} for ${duplicate.payorName}. Recording it again would put the same money in the ledger twice.`,
      );
      return;
    }

    // The same detail a counter receipt is held to. An e-collection feeds the
    // same Abstract of Real Property Tax Collections and the same Registry of
    // Special Trust Fund, and a gap costs the same there.
    const problems = receiptDetailProblems(lines, fundCode);
    if (problems.length > 0) {
      toast.error('The receipt is missing detail the reports need', describeProblems(problems));
      return;
    }

    const chosen = intermediaries.data.find((i) => i.id === intermediaryId);

    // Patch 156: particulars are required on every entry.
    if (!particulars.trim()) {
      toast.error('Particulars are required', 'Say what this entry is for - it is printed on the reports.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
          fiscalYear,
          period: Number(receiptDate.slice(5, 7)),
          fundCode,
          /*
           * The receipt number goes in `orNumber`, the same field a counter
           * receipt uses, so every report that already reads collections finds
           * it without being taught about a second field.
           */
          orNumber: normalise(receiptNo),
          orDate: receiptDate,
          eCollectionKind: kind,
          intermediaryId: spec.withIntermediary ? intermediaryId : null,
          intermediaryName: spec.withIntermediary ? (chosen?.name ?? null) : null,
          responsibilityCenterCode: spec.withResponsibilityCentre
            ? responsibilityCenterCode.trim() || null
            : null,
          prexcPap: spec.withResponsibilityCentre ? prexcPap.trim() || null : null,
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
            particulars: l.particulars ?? particulars.trim() ?? null,
            trustProgramId: isTrust ? (l.trustProgramId ?? null) : null,
            trustProgramName: isTrust ? (l.trustProgramName ?? null) : null,
            rptTaxYear: isRptAccount(l.accountCode ?? '') ? (l.rptTaxYear ?? null) : null,
            barangayId: isRptAccount(l.accountCode ?? '') ? (l.barangayId ?? null) : null,
            barangayName: isRptAccount(l.accountCode ?? '') ? (l.barangayName ?? null) : null,
          })),
          totalAmount: total,
          paymentForm: 'ONLINE',
          /*
           * No accountable form is consumed, and deliberately.
           *
           * A paper Official Receipt comes out of a numbered booklet the
           * Treasurer signed for, and the RAAF accounts for every one of them.
           * An electronic receipt has no booklet, so asking the RAAF to
           * account for it would mean the Treasurer answering for serial
           * numbers that were never issued to anybody.
           */
          accountableFormId: null,
          remarks: particulars.trim() || null,
      };

      const stamp = actorStamp({
        uid: user.uid,
        name: profile?.displayName ?? user.email ?? user.uid,
        position: profile?.position,
      });

      if (editingRecord) {
        // The status stays as it is - see the note on the cash collection
        // form. Writing ISSUED back over a banked receipt would un-bank it.
        await updateDraft(COL.collections, editingRecord.id, payload, stamp);
      } else {
        await createDraft(COL.collections, { ...payload, status: 'ISSUED' }, stamp);
      }
      onSaved(normalise(receiptNo));
    } catch (err) {
      toast.error('Could not record the e-collection', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={editingRecord ? `Correct ${editingRecord.orNumber}` : 'Record an e-collection'}
      description={
        editingRecord
          ? 'Correcting the encoding. Editable until a certified report has claimed it.'
          : 'One electronic receipt, with its revenue account distribution.'
      }
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            {editingRecord ? 'Save the correction' : 'Record'}
          </Button>
        </>
      }
    >
      <Field label="How did the money arrive?" required htmlFor="kind">
        <Select
          id="kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as ECollectionKind)}
        >
          {E_COLLECTION_KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </Select>
      </Field>
      <p className="mt-1 mb-4 text-xs leading-snug text-slate-600">{spec.when}</p>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={spec.numberLabel} required htmlFor="receiptNo">
          <TextInput
            id="receiptNo"
            value={receiptNo}
            onChange={(e) => setReceiptNo(e.target.value)}
            className="font-mono"
          />
        </Field>
        <Field label="Date" required htmlFor="receiptDate">
          <DateInput id="receiptDate" value={receiptDate} onChange={setReceiptDate} />
        </Field>
        <Field
          label={kind === 'AR' ? 'Designated officer' : 'Collecting officer'}
          required
          htmlFor="officer"
        >
          <EmployeePicker
            id="officer"
            value={officerId}
            onChange={(v, emp) => {
              setOfficerId(v);
              setOfficerName(emp?.name ?? '');
            }}
          />
        </Field>
      </div>

      <p className="mt-1 text-xs leading-snug text-slate-500">{spec.numberHint}</p>

      {duplicate && (
        <Alert tone="error" className="mt-3" title="This number is already in the register">
          {duplicate.orNumber} was recorded on {formatShortDate(duplicate.orDate)} for{' '}
          {duplicate.payorName}, {formatPeso(duplicate.totalAmount)}. Check the intermediary's list
          before recording it again.
        </Alert>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {spec.withIntermediary && (
          <Field label="Intermediary" required htmlFor="intermediary" className="sm:col-span-3">
            <Select
              id="intermediary"
              value={intermediaryId}
              onChange={(e) => setIntermediaryId(e.target.value)}
            >
              <option value="">Who held the money?</option>
              {intermediaries.data
                .filter((i) => i.active !== false)
                .map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.code} - {i.name}
                  </option>
                ))}
            </Select>
          </Field>
        )}

        <Field label="Payor" required htmlFor="payor" className="sm:col-span-2">
          <TextInput id="payor" value={payorName} onChange={(e) => setPayorName(e.target.value)} />
        </Field>
        <Field label="Payor TIN" htmlFor="payorTin">
          <TextInput id="payorTin" value={payorTin} onChange={(e) => setPayorTin(e.target.value)} />
        </Field>

        <Field label="Particulars" required htmlFor="particulars" className="sm:col-span-3">
          <TextInput
            id="particulars"
            value={particulars}
            onChange={(e) => setParticulars(e.target.value)}
            placeholder="The nature of the collection, as it should read on the report"
          />
        </Field>

        {spec.withResponsibilityCentre && (
          <>
            {/*
             * Two columns Annexes E and F carry and the counter receipt does
             * not. Both are optional on the record: a collection refused for
             * want of a code nobody has assigned yet would simply be recorded
             * outside CFMS, which is worse.
             */}
            <Field label="Responsibility centre code" htmlFor="rcc">
              <Select
                id="rcc"
                value={responsibilityCenterCode}
                onChange={(e) => setResponsibilityCenterCode(e.target.value)}
              >
                <option value="">Not stated</option>
                {offices.data
                  .filter((o) => o.functionCode)
                  .map((o) => (
                    <option key={o.id} value={o.functionCode ?? ''}>
                      {o.functionCode} - {o.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="PREXC / PAP" htmlFor="prexc">
              <TextInput id="prexc" value={prexcPap} onChange={(e) => setPrexcPap(e.target.value)} />
            </Field>
          </>
        )}

        <Field label="Revenue source" htmlFor="source">
          <Select
            id="source"
            value={revenueSource}
            onChange={(e) => setRevenueSource(e.target.value as RevenueSource)}
          >
            {REVENUE_SOURCES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="mt-5">
        <p className="cbo-label">Revenue accounts</p>
        <p className="mb-2 text-xs text-slate-500">
          These become the Breakdown of Collections columns on the printed report, one column per
          account.
        </p>
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
                          i === index ? { ...l, accountCode: code ?? undefined, accountName: account?.name } : l,
                        ),
                      )
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
                                  ? {
                                      ...l,
                                      rptTaxYear: (e.target.value || undefined) as
                                        | 'CURRENT'
                                        | 'PRECEDING'
                                        | undefined,
                                    }
                                  : l,
                              ),
                            )
                          }
                        >
                          <option value="">Which tax year?</option>
                          <option value="CURRENT">Current year</option>
                          <option value="PRECEDING">Preceding year</option>
                        </Select>
                        {sharesWithBarangay(line.accountCode ?? '') && (
                          <Select
                            value={line.barangayId ?? ''}
                            onChange={(e) => {
                              const id = e.target.value || undefined;
                              const chosen = barangays.data.find((b) => b.id === id);
                              setLines((ls) =>
                                ls.map((l, i) =>
                                  i === index ? { ...l, barangayId: id, barangayName: chosen?.name } : l,
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
