import { useMemo, useState } from 'react';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Field, Select, DateInput, AmountInput, TextInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { AccountPicker, EmployeePicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useBarangays, useCollections, useTrustPrograms } from '@/data/queries';
import { createDraft, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { formatPeso } from '@/lib/money';
import { TRUST_FUND_CODE } from '@/lib/trustPrograms';
import { isRptAccount, sharesWithBarangay } from '@/pages/reports/rptAbstractReport';
import { formatShortDate, monthName, todayPh } from '@/lib/dates';
import { REVENUE_SOURCES } from '@/types/treasury';
import type { Collection, CollectionLine, RevenueSource } from '@/types/treasury';
import { fundLabel } from '../budget/Obligations';
import { COLLECTION_TABS, COLLECTION_CRUMBS } from './sections';


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
  const [source, setSource] = useState('');

  const rows = useMemo(
    () =>
      data
        .filter((c) => !period || Number(c.orDate?.slice(5, 7)) === period)
        .filter((c) => !source || c.revenueSource === source),
    [data, period, source],
  );

  const total = rows.filter((c) => c.status !== 'CANCELLED').reduce((s, c) => s + c.totalAmount, 0);
  const undeposited = rows
    .filter((c) => ['ISSUED', 'IN_RCD'].includes(c.status))
    .reduce((s, c) => s + c.totalAmount, 0);

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
  ];

  return (
    <div>
      <PageHeader
        title="Collections and Deposits"
        subtitle={`${fundLabel(fundCode)} - fiscal year ${fiscalYear}${period ? `, ${monthName(period)}` : ''} - ${formatPeso(total)} collected`}
        breadcrumbs={COLLECTION_CRUMBS}
        actions={
          can('treasury', 'create') && (
            <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
              Record collection
            </Button>
          )
        }
      />

      <SectionTabs tabs={COLLECTION_TABS} />

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
        exportMeta={{
          title: 'Revenue Collection Report',
          fundLabel: fundLabel(fundCode),
          periodLabel: period
            ? `For the month of ${monthName(period)} ${fiscalYear}`
            : `For the fiscal year ${fiscalYear}`,
        }}
        footer={
          <tr>
            <td className="cbo-td font-medium" colSpan={4}>
              Total - {rows.filter((c) => c.status !== 'CANCELLED').length} receipts
            </td>
            <td className="cbo-td cbo-amount font-semibold">{formatPeso(total, { symbol: false })}</td>
            <td className="cbo-td" colSpan={2} />
          </tr>
        }
      />

      {showForm && (
        <CollectionForm
          fiscalYear={fiscalYear}
          fundCode={fundCode}
          onClose={() => setShowForm(false)}
          onSaved={(orNumber) => {
            setShowForm(false);
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
  onClose,
  onSaved,
}: {
  fiscalYear: number;
  fundCode: string;
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

  const [orNumber, setOrNumber] = useState('');
  const [orDate, setOrDate] = useState(todayPh());
  const [officerId, setOfficerId] = useState<string | null>(null);
  const [officerName, setOfficerName] = useState('');
  const [payorName, setPayorName] = useState('');
  const [payorTin, setPayorTin] = useState('');
  const [revenueSource, setRevenueSource] = useState<RevenueSource>('FEES_AND_CHARGES');
  const [paymentForm, setPaymentForm] = useState<'CASH' | 'CHECK' | 'ONLINE' | 'CARD'>('CASH');
  const [checkNo, setCheckNo] = useState('');
  const [lines, setLines] = useState<Array<Partial<CollectionLine>>>([{ lineNo: 1 }]);
  const [saving, setSaving] = useState(false);

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
    setSaving(true);
    try {
      await createDraft(
        COL.collections,
        {
          fiscalYear,
          period: Number(orDate.slice(5, 7)),
          fundCode,
          orNumber: orNumber.trim().toUpperCase(),
          orDate,
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
            particulars: l.particulars ?? null,
            // Trust Fund only. A programme on a General Fund receipt would be
            // a mistake, and the server ignores it rather than acting on it.
            trustProgramId: isTrust ? (l.trustProgramId ?? null) : null,
            trustProgramName: isTrust ? (l.trustProgramName ?? null) : null,
            // Real property tax only. A tax year or a barangay on a permit fee
            // would be noise the abstract then has to ignore.
            rptTaxYear: isRptAccount(l.accountCode ?? '') ? (l.rptTaxYear ?? null) : null,
            barangayId: isRptAccount(l.accountCode ?? '') ? (l.barangayId ?? null) : null,
            barangayName: isRptAccount(l.accountCode ?? '') ? (l.barangayName ?? null) : null,
          })),
          totalAmount: total,
          paymentForm,
          checkNo: paymentForm === 'CHECK' ? checkNo.trim() || null : null,
          status: 'ISSUED',
        },
        actorStamp({
          uid: user.uid,
          name: profile?.displayName ?? user.email ?? user.uid,
          position: profile?.position,
        }),
      );
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
      title="Record a collection"
      description="One official receipt, with its revenue account distribution."
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Record
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-3">
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
      </div>

      <div className="mt-5">
        <p className="cbo-label">Revenue accounts</p>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="cbo-th min-w-[18rem]">Account</th>
              {isTrust && <th className="cbo-th min-w-[16rem]">Trust programme</th>}
              {anyRpt && <th className="cbo-th min-w-[18rem]">Tax year and barangay</th>}
              <th className="cbo-th w-36 text-right">Amount</th>
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
                      <option value="">Not yet known</option>
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
                          <option value="">Year not stated</option>
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
                            <option value="">Barangay not stated</option>
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
