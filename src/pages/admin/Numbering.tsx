import { useMemo, useState } from 'react';
import { orderBy } from 'firebase/firestore';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Field, TextInput, Select, Checkbox } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useCollection } from '@/hooks/useFirestore';
import { useAuth } from '@/auth/AuthProvider';
import { upsertMaster, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { renderDocumentNumber, DEFAULT_NUMBERING_RULES } from '@/lib/numbering';
import { todayPh } from '@/lib/dates';
import { DOC_TYPE_LABELS, type DocType } from '@/types/enums';
import type { NumberingRule } from '@/types/master';

/**
 * Document numbering.
 *
 * The format Candoni uses is {BOOK}-{YY}-{MM}-{SEQ}, giving numbers like
 * 100-26-09-0001: fund book code, year, month, sequence.
 *
 * Numbers are issued only inside the Firestore transaction that commits the
 * document, drawing from a counter document. That is what makes two users
 * pressing Submit in the same second receive consecutive numbers rather than
 * the same one - and why a discarded draft never leaves a gap in the series.
 */
export default function Numbering() {
  const { hasRole, user, profile } = useAuth();
  const toast = useToast();
  const [editing, setEditing] = useState<Partial<NumberingRule> | null>(null);

  const { data, loading, error } = useCollection<NumberingRule>(
    COL.numberingRules,
    [orderBy('docType')],
    ['numberingRules'],
  );

  const isAdmin = hasRole('SUPER_ADMIN');

  /** Rules that exist, plus the built-in defaults for types not yet configured. */
  const rows = useMemo<NumberingRule[]>(() => {
    const configured = new Map(data.map((r) => [r.docType, r]));
    const out: NumberingRule[] = [...data];

    for (const fallback of DEFAULT_NUMBERING_RULES) {
      if (configured.has(fallback.docType)) continue;
      out.push({
        id: fallback.docType,
        docType: fallback.docType,
        pattern: fallback.pattern,
        sequenceLength: fallback.sequenceLength,
        resetOn: fallback.resetOn,
        perFund: fallback.perFund,
        active: true,
      });
    }

    return out.sort((a, b) => a.docType.localeCompare(b.docType));
  }, [data]);

  const sample = (rule: NumberingRule) =>
    renderDocumentNumber(
      rule.pattern,
      {
        bookCode: '100',
        fundCode: 'GF',
        docType: rule.docType,
        fiscalYear: Number(todayPh().slice(0, 4)),
        month: Number(todayPh().slice(5, 7)),
        sequence: 1,
      },
      rule.sequenceLength,
    );

  const columns: Column<NumberingRule>[] = [
    {
      key: 'docType',
      header: 'Document type',
      value: (r) => r.docType,
      cell: (r) => (
        <div>
          <span className="font-mono text-xs text-navy-900">{r.docType}</span>
          <span className="block text-xs text-slate-500">
            {DOC_TYPE_LABELS[r.docType as DocType] ?? r.docType}
          </span>
        </div>
      ),
    },
    {
      key: 'pattern',
      header: 'Pattern',
      value: (r) => r.pattern,
      cell: (r) => <span className="font-mono text-xs">{r.pattern}</span>,
    },
    {
      key: 'sample',
      header: 'Example',
      value: (r) => sample(r),
      cell: (r) => <span className="font-mono text-sm text-navy-900">{sample(r)}</span>,
    },
    {
      key: 'resetOn',
      header: 'Sequence resets',
      width: '9rem',
      value: (r) => r.resetOn,
      cell: (r) => (
        <span className="text-xs">
          {r.resetOn === 'MONTH' ? 'Every month' : r.resetOn === 'YEAR' ? 'Every year' : 'Never'}
        </span>
      ),
    },
    {
      key: 'perFund',
      header: 'Per fund',
      width: '7rem',
      align: 'center',
      value: (r) => (r.perFund ? 'Yes' : 'No'),
      cell: (r) => <span className="text-xs">{r.perFund ? 'Yes' : 'No'}</span>,
    },
    {
      key: 'actions',
      header: '',
      width: '6rem',
      sortable: false,
      fixed: true,
      value: () => '',
      cell: (r) =>
        isAdmin ? (
          <Button size="sm" onClick={() => setEditing(r)}>
            Edit
          </Button>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Document Numbering"
        subtitle="The format of OBR, DV, JEV, check, ADA, RCD, liquidation and payroll numbers."
        breadcrumbs={[{ label: 'Administration' }, { label: 'Numbering' }]}
      />

      <Alert tone="info" className="mb-4">
        Tokens: <code className="font-mono">{'{BOOK}'}</code> fund book code,{' '}
        <code className="font-mono">{'{FUND}'}</code> fund short code,{' '}
        <code className="font-mono">{'{TYPE}'}</code> document type,{' '}
        <code className="font-mono">{'{YYYY}'}</code> and <code className="font-mono">{'{YY}'}</code>{' '}
        year, <code className="font-mono">{'{MM}'}</code> month,{' '}
        <code className="font-mono">{'{SEQ}'}</code> zero-padded sequence. Changing a pattern
        affects documents numbered from that point on; numbers already issued are never rewritten.
      </Alert>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        loading={loading}
        error={error}
        emptyTitle="No numbering rules"
        exportMeta={{ title: 'Document Numbering Configuration' }}
      />

      {editing && user && (
        <RuleForm
          rule={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            toast.success('Numbering rule saved', 'It applies to documents numbered from now on.');
          }}
          actor={actorStamp({
            uid: user.uid,
            name: profile?.displayName ?? user.email ?? user.uid,
            position: profile?.position,
          })}
        />
      )}
    </div>
  );
}

function RuleForm({
  rule,
  onClose,
  onSaved,
  actor,
}: {
  rule: Partial<NumberingRule>;
  onClose: () => void;
  onSaved: () => void;
  actor: ReturnType<typeof actorStamp>;
}) {
  const toast = useToast();
  const [pattern, setPattern] = useState(rule.pattern ?? '{BOOK}-{YY}-{MM}-{SEQ}');
  const [sequenceLength, setSequenceLength] = useState(rule.sequenceLength ?? 4);
  const [resetOn, setResetOn] = useState<'YEAR' | 'MONTH' | 'NEVER'>(rule.resetOn ?? 'MONTH');
  const [perFund, setPerFund] = useState(rule.perFund ?? true);
  const [saving, setSaving] = useState(false);

  const preview = renderDocumentNumber(
    pattern,
    {
      bookCode: '100',
      fundCode: 'GF',
      docType: rule.docType ?? 'DV',
      fiscalYear: Number(todayPh().slice(0, 4)),
      month: Number(todayPh().slice(5, 7)),
      sequence: 1,
    },
    sequenceLength,
  );

  const save = async () => {
    if (!pattern.includes('{SEQ}')) {
      toast.error(
        'The pattern must include {SEQ}',
        'Without a sequence token every document of this type would receive the same number.',
      );
      return;
    }
    setSaving(true);
    try {
      await upsertMaster(
        COL.numberingRules,
        rule.docType!,
        { docType: rule.docType, pattern, sequenceLength, resetOn, perFund, active: true },
        actor,
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
      title={`Numbering for ${DOC_TYPE_LABELS[rule.docType as DocType] ?? rule.docType}`}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Pattern" required htmlFor="pattern">
          <TextInput
            id="pattern"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            className="font-mono"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Sequence length" htmlFor="seqlen">
            <TextInput
              id="seqlen"
              type="number"
              min={2}
              max={8}
              value={sequenceLength}
              onChange={(e) => setSequenceLength(Math.min(8, Math.max(2, Number(e.target.value) || 4)))}
              className="font-mono"
            />
          </Field>

          <Field label="Sequence resets" htmlFor="resetOn">
            <Select id="resetOn" value={resetOn} onChange={(e) => setResetOn(e.target.value as typeof resetOn)}>
              <option value="MONTH">Every month</option>
              <option value="YEAR">Every year</option>
              <option value="NEVER">Never</option>
            </Select>
          </Field>
        </div>

        <Checkbox
          checked={perFund}
          onChange={setPerFund}
          label="Keep a separate sequence per fund"
          hint="Almost always correct: the General Fund and the Special Education Fund each keep their own numbering."
        />

        <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
          <p className="text-xs text-slate-600">Next number would look like</p>
          <p className="mt-1 font-mono text-xl font-semibold text-navy-900">{preview}</p>
        </div>

        <Alert tone="warning">
          Changing the pattern or the reset policy starts a new counter. Existing documents keep
          the numbers they were issued, and no attempt is made to renumber them - a document
          number that has been printed, signed and filed cannot be changed.
        </Alert>
      </div>
    </Modal>
  );
}
