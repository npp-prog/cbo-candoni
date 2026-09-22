import { useMemo, useState } from 'react';
import { collection, orderBy, query, where } from 'firebase/firestore';
import { PageHeader, Alert } from '@/components/ui/Layout';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Field, TextInput, DateInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { EmployeePicker } from '@/components/pickers';
import { useCollection } from '@/hooks/useFirestore';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { createDraft, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { formatShortDate, todayPh } from '@/lib/dates';
import type { AccountableForm } from '@/types/treasury';

/**
 * Accountable forms.
 *
 * Official receipts and community tax certificates are controlled stationery:
 * COA holds the accountable officer personally answerable for every serial
 * number issued to them. This screen keeps the Statement of Accountability for
 * Accountable Forms, which is a count of pieces rather than a money figure -
 * the one place in CBO where the quantities are not centavos.
 */
export default function AccountableForms() {
  const { fiscalYear } = useFilters();
  const { can } = useAuth();
  const toast = useToast();
  const [showForm, setShowForm] = useState(false);

  const { data, loading, error } = useCollection<AccountableForm>(
    COL.accountableForms,
    [where('fiscalYear', '==', fiscalYear), orderBy('formType')],
    ['accountableForms', fiscalYear],
  );

  const columns: Column<AccountableForm>[] = [
    {
      key: 'formType',
      header: 'Form',
      value: (f) => f.formType,
      cell: (f) => (
        <div>
          <span className="text-sm text-navy-900">{f.formType}</span>
          <span className="block font-mono text-2xs text-slate-500">{f.formCode}</span>
        </div>
      ),
    },
    {
      key: 'officer',
      header: 'Accountable officer',
      value: (f) => f.accountableOfficerName,
      cell: (f) => <span className="text-sm">{f.accountableOfficerName}</span>,
    },
    {
      key: 'serials',
      header: 'Serial range',
      value: (f) => f.serialFrom,
      cell: (f) => (
        <span className="font-mono text-xs text-slate-600">
          {f.serialFrom} to {f.serialTo}
        </span>
      ),
    },
    {
      key: 'beginning',
      header: 'Beginning',
      kind: 'number',
      align: 'right',
      value: (f) => f.beginningBalance,
      cell: (f) => <span className="font-mono text-sm tabular">{f.beginningBalance.toLocaleString('en-PH')}</span>,
    },
    {
      key: 'received',
      header: 'Received',
      kind: 'number',
      align: 'right',
      value: (f) => f.received,
      cell: (f) => <span className="font-mono text-sm tabular">{f.received.toLocaleString('en-PH')}</span>,
    },
    {
      key: 'issued',
      header: 'Issued',
      kind: 'number',
      align: 'right',
      value: (f) => f.issued,
      cell: (f) => <span className="font-mono text-sm tabular">{f.issued.toLocaleString('en-PH')}</span>,
    },
    {
      key: 'cancelled',
      header: 'Cancelled',
      kind: 'number',
      align: 'right',
      value: (f) => f.cancelled,
      cell: (f) => <span className="font-mono text-sm tabular">{f.cancelled.toLocaleString('en-PH')}</span>,
    },
    {
      key: 'ending',
      header: 'Ending',
      kind: 'number',
      align: 'right',
      value: (f) => f.endingBalance,
      cell: (f) => (
        <span className="font-mono text-sm font-semibold tabular">
          {f.endingBalance.toLocaleString('en-PH')}
        </span>
      ),
    },
    {
      key: 'asOf',
      header: 'As at',
      kind: 'date',
      width: '7rem',
      value: (f) => f.asOfDate,
      cell: (f) => <span className="text-xs">{formatShortDate(f.asOfDate)}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Accountable Forms"
        subtitle={`Statement of accountability - fiscal year ${fiscalYear}`}
        breadcrumbs={[{ label: 'Treasury' }, { label: 'Accountable Forms' }]}
        actions={
          can('treasury', 'create') && (
            <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
              Record accountability
            </Button>
          )
        }
      />

      <SectionTabs tabs={[{ label: 'Accountable Forms', to: '/treasury/accountable-forms' }, { label: 'Report of Accountability (RAAF)', to: '/treasury/accountable-forms/raaf' }]} />

      <Alert tone="info" className="mb-4">
        Quantities on this screen are pieces of controlled stationery, not amounts. Ending balance
        is beginning balance plus forms received, less those issued and cancelled.
      </Alert>

      <DataTable
        rows={data}
        columns={columns}
        rowKey={(f) => f.id}
        loading={loading}
        error={error}
        searchPlaceholder="Form type, officer or serial number"
        emptyTitle="No accountable forms recorded"
        emptyMessage="Record each officer's accountability for official receipts and other controlled forms."
        exportMeta={{
          title: 'Statement of Accountability for Accountable Forms',
          periodLabel: `As at ${formatShortDate(todayPh())}`,
        }}
      />

      {showForm && (
        <FormDialog
          fiscalYear={fiscalYear}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            toast.success('Accountability recorded');
          }}
        />
      )}
    </div>
  );
}

function FormDialog({
  fiscalYear,
  onClose,
  onSaved,
}: {
  fiscalYear: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { user, profile } = useAuth();

  const [formType, setFormType] = useState('Official Receipt (Accountable Form No. 51)');
  const [formCode, setFormCode] = useState('51');
  const [serialFrom, setSerialFrom] = useState('');
  const [serialTo, setSerialTo] = useState('');
  const [officerId, setOfficerId] = useState<string | null>(null);
  const [officerName, setOfficerName] = useState('');
  const [beginningBalance, setBeginningBalance] = useState(0);
  const [received, setReceived] = useState(0);
  const [issued, setIssued] = useState(0);
  const [cancelled, setCancelled] = useState(0);
  const [asOfDate, setAsOfDate] = useState(todayPh());
  const [saving, setSaving] = useState(false);

  const endingBalance = beginningBalance + received - issued - cancelled;

  const save = async () => {
    if (!officerId || !formType.trim() || !user) {
      toast.error('Incomplete', 'Form type and accountable officer are required.');
      return;
    }
    if (endingBalance < 0) {
      toast.error(
        'The quantities do not reconcile',
        'More forms have been issued and cancelled than were on hand. Check the counts.',
      );
      return;
    }
    setSaving(true);
    try {
      await createDraft(
        COL.accountableForms,
        {
          fiscalYear,
          formType: formType.trim(),
          formCode: formCode.trim(),
          serialFrom: serialFrom.trim(),
          serialTo: serialTo.trim(),
          accountableOfficerId: officerId,
          accountableOfficerName: officerName,
          beginningBalance,
          received,
          issued,
          cancelled,
          endingBalance,
          asOfDate,
        },
        actorStamp({
          uid: user.uid,
          name: profile?.displayName ?? user.email ?? user.uid,
          position: profile?.position,
        }),
      );
      onSaved();
    } catch (err) {
      toast.error('Could not save', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Record accountability for forms"
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Form type" required htmlFor="ftype" className="sm:col-span-2">
          <TextInput id="ftype" value={formType} onChange={(e) => setFormType(e.target.value)} />
        </Field>
        <Field label="Form code" htmlFor="fcode">
          <TextInput id="fcode" value={formCode} onChange={(e) => setFormCode(e.target.value)} className="font-mono" />
        </Field>
        <Field label="Accountable officer" required htmlFor="afOfficer">
          <EmployeePicker
            id="afOfficer"
            value={officerId}
            onChange={(v, emp) => {
              setOfficerId(v);
              setOfficerName(emp?.name ?? '');
            }}
          />
        </Field>
        <Field label="Serial from" htmlFor="sfrom">
          <TextInput id="sfrom" value={serialFrom} onChange={(e) => setSerialFrom(e.target.value)} className="font-mono" />
        </Field>
        <Field label="Serial to" htmlFor="sto">
          <TextInput id="sto" value={serialTo} onChange={(e) => setSerialTo(e.target.value)} className="font-mono" />
        </Field>

        <Count label="Beginning balance" value={beginningBalance} onChange={setBeginningBalance} />
        <Count label="Received" value={received} onChange={setReceived} />
        <Count label="Issued" value={issued} onChange={setIssued} />
        <Count label="Cancelled" value={cancelled} onChange={setCancelled} />

        <Field label="As at" required htmlFor="asOf">
          <DateInput id="asOf" value={asOfDate} onChange={setAsOfDate} />
        </Field>

        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5">
          <p className="text-xs text-slate-600">Ending balance</p>
          <p
            className={`mt-1 font-mono text-lg font-semibold tabular ${endingBalance < 0 ? 'text-rose-700' : 'text-navy-900'}`}
          >
            {endingBalance.toLocaleString('en-PH')}
          </p>
        </div>
      </div>
    </Modal>
  );
}

function Count({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label}>
      <TextInput
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
        className="font-mono text-right"
      />
    </Field>
  );
}
