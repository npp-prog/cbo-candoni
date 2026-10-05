import { useMemo, useState } from 'react';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Button } from '@/components/ui/Button';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Field, TextInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { OfficePicker } from '@/components/pickers';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { usePrograms, useAppropriations } from '@/data/queries';
import { upsertMaster, deactivateMaster, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { formatPeso } from '@/lib/money';
import { programDocId } from '@/lib/budgetPrograms';
import type { Program } from '@/types/master';
import { AppropriationTabs } from './appropriationTabs';

/**
 * The budget programmes of one fiscal year.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS PER YEAR
 * ---------------------------------------------------------------------------
 * A Function, Programme or Project is what the Sanggunian appropriated to in
 * one annual budget. Next year's ordinance may keep it, rename it, split it in
 * two or drop it, and when it drops one the programme does not become wrong
 * retrospectively - the FY2026 appropriations still have to show what they
 * were made to.
 *
 * As one standing list, renaming a programme this year silently rewrote the
 * label on last year's appropriations. Nobody notices that until a comparison
 * report disagrees with a printed budget.
 *
 * So the same code in two years is two records, and COPY FROM LAST YEAR is how
 * a year starts without typing two hundred names again.
 *
 * ---------------------------------------------------------------------------
 * THE PROGRAMMES WITH NO YEAR
 * ---------------------------------------------------------------------------
 * Every programme created before patch 86 has no year on it: the ordinance
 * importer wrote them with a code and a name and nothing else. They are shown
 * in their own section rather than hidden, because a programme that belongs to
 * no year appears in no list - and a record that exists but cannot be found is
 * worse than one that does not exist.
 *
 * ADOPT INTO THIS YEAR copies it, leaving the original alone. Nothing already
 * appropriated is touched: an appropriation carries its own fppCode and
 * fppName, so it does not depend on the programme record still being there.
 */
export default function BudgetPrograms() {
  const { fiscalYear, fundCode } = useFilters();
  const { can } = useAuth();
  const toast = useToast();

  const programs = usePrograms();
  const appropriations = useAppropriations(fiscalYear, fundCode);

  const [editing, setEditing] = useState<Program | 'new' | null>(null);
  const [copying, setCopying] = useState(false);
  const [removing, setRemoving] = useState<Program | null>(null);
  const [busy, setBusy] = useState(false);

  const mayEdit = can('budget', 'create');

  const thisYear = useMemo(
    () => programs.data.filter((p) => p.fiscalYear === fiscalYear),
    [programs.data, fiscalYear],
  );

  const lastYear = useMemo(
    () => programs.data.filter((p) => p.fiscalYear === fiscalYear - 1),
    [programs.data, fiscalYear],
  );

  const unassigned = useMemo(
    () => programs.data.filter((p) => p.fiscalYear === undefined || p.fiscalYear === null),
    [programs.data],
  );

  /** Codes already in this year, so a copy or an adoption cannot duplicate one. */
  const taken = useMemo(() => new Set(thisYear.map((p) => p.code.trim())), [thisYear]);

  /**
   * What has actually been appropriated to each programme this year.
   *
   * Shown because the question the office asks of this list is almost never
   * "what programmes exist" - it is "which of them has anything in it", which
   * is how an unused programme from a copy-forward gets noticed and removed.
   */
  const appropriatedBy = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of appropriations.data) {
      if (a.status === 'CANCELLED') continue;
      map.set(a.fppCode, (map.get(a.fppCode) ?? 0) + a.amount);
    }
    return map;
  }, [appropriations.data]);

  const save = async (values: { code: string; name: string; officeId: string | null; officeName: string }) => {
    const code = values.code.trim();
    const name = values.name.trim();
    if (!code || !name) {
      toast.error('Incomplete', 'A programme needs its code and its name.');
      return;
    }
    if (editing === 'new' && taken.has(code)) {
      toast.error(
        `${code} is already a programme this year`,
        'Open the existing one to change it, rather than adding a second record under the same code.',
      );
      return;
    }

    setBusy(true);
    try {
      const actor = actorStamp({ uid: 'ui', name: 'ui' });
      await upsertMaster(
        COL.programs,
        editing === 'new' ? programDocId(fiscalYear, code) : (editing as Program).id,
        {
          code,
          name,
          fiscalYear,
          officeId: values.officeId ?? null,
          officeName: values.officeName || null,
          active: true,
        },
        actor,
      );
      toast.success(editing === 'new' ? `${code} added` : `${code} saved`);
      setEditing(null);
    } catch (err) {
      toast.error('Could not save', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** Copies last year's programmes into this one, skipping codes already here. */
  const copyForward = async () => {
    const toCopy = lastYear.filter((p) => !taken.has(p.code.trim()));
    if (toCopy.length === 0) {
      toast.info('Nothing to copy', `Every ${fiscalYear - 1} programme is already in ${fiscalYear}.`);
      setCopying(false);
      return;
    }

    setBusy(true);
    try {
      const actor = actorStamp({ uid: 'ui', name: 'ui' });
      for (const p of toCopy) {
        await upsertMaster(
          COL.programs,
          programDocId(fiscalYear, p.code),
          {
            code: p.code.trim(),
            name: p.name,
            fiscalYear,
            officeId: p.officeId ?? null,
            officeName: p.officeName ?? null,
            active: true,
          },
          actor,
        );
      }
      toast.success(
        `${toCopy.length} programme${toCopy.length === 1 ? '' : 's'} copied into ${fiscalYear}`,
        'Remove any the ordinance did not carry over.',
      );
      setCopying(false);
    } catch (err) {
      toast.error('The copy did not finish', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const adopt = async (p: Program) => {
    setBusy(true);
    try {
      await upsertMaster(
        COL.programs,
        programDocId(fiscalYear, p.code),
        {
          code: p.code.trim(),
          name: p.name,
          fiscalYear,
          officeId: p.officeId ?? null,
          officeName: p.officeName ?? null,
          active: true,
        },
        actorStamp({ uid: 'ui', name: 'ui' }),
      );
      toast.success(`${p.code} adopted into ${fiscalYear}`);
    } catch (err) {
      toast.error('Could not adopt it', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<Program>[] = [
    {
      key: 'code',
      header: 'Code',
      width: '8rem',
      value: (p) => p.code,
      cell: (p) => <span className="font-mono text-xs">{p.code}</span>,
    },
    {
      key: 'name',
      header: 'Programme, project or function',
      value: (p) => p.name,
      cell: (p) => <span className="text-sm">{p.name}</span>,
    },
    {
      key: 'office',
      header: 'Office',
      value: (p) => p.officeName ?? '',
      cell: (p) => <span className="text-xs text-slate-600">{p.officeName ?? '-'}</span>,
      optional: true,
    },
    {
      key: 'appropriated',
      header: 'Appropriated',
      kind: 'amount',
      value: (p) => appropriatedBy.get(p.code) ?? 0,
      cell: (p) => {
        const amount = appropriatedBy.get(p.code) ?? 0;
        return amount === 0 ? (
          <span className="text-xs italic text-slate-400">Nothing yet</span>
        ) : (
          formatPeso(amount, { symbol: false })
        );
      },
    },
    {
      key: 'actions',
      header: '',
      width: '9rem',
      value: () => '',
      fixed: true,
      sortable: false,
      cell: (p) =>
        mayEdit ? (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRemoving(p)}>
              Remove
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Budget Programmes"
        subtitle={`Fiscal year ${fiscalYear} - ${thisYear.length} programme${thisYear.length === 1 ? '' : 's'}`}
        breadcrumbs={[{ label: 'Budget' }, { label: 'Appropriations' }, { label: 'Budget Programmes' }]}
        actions={
          mayEdit && (
            <div className="flex items-center gap-2">
              {lastYear.length > 0 && (
                <Button variant="secondary" size="sm" onClick={() => setCopying(true)}>
                  Copy from {fiscalYear - 1}
                </Button>
              )}
              <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
                Add a programme
              </Button>
            </div>
          )
        }
      />

      <AppropriationTabs active="programmes" />

      <div className="my-4" />

      {thisYear.length === 0 && lastYear.length > 0 && (
        <Alert tone="info" className="mb-4" title={`No programmes in ${fiscalYear} yet`}>
          {lastYear.length} were set up for {fiscalYear - 1}. <strong>Copy from {fiscalYear - 1}</strong>{' '}
          brings them across; you then remove the ones this year's ordinance did not carry over and
          add whatever is new. Loading the ordinance itself also creates them, for the lines the
          annex appropriates by project.
        </Alert>
      )}

      <Card bodyClassName="p-0">
        <DataTable
          rows={thisYear}
          columns={columns}
          rowKey={(p) => p.id}
          loading={programs.loading}
          error={programs.error}
          searchPlaceholder="Code or programme name"
          emptyTitle={`No programmes for ${fiscalYear}`}
          emptyMessage="A programme is what the ordinance appropriated to where it named a project or a function rather than an object of expenditure."
          exportMeta={{
            title: 'Budget Programmes',
            periodLabel: `For the fiscal year ${fiscalYear}`,
          }}
        />
      </Card>

      {unassigned.length > 0 && (
        <Card
          className="mt-4"
          title="Not yet assigned to a year"
          subtitle="Created by an ordinance upload before CFMS kept programmes per year. They are in no year's list until one of them is adopted."
          bodyClassName="p-0"
        >
          <DataTable
            rows={unassigned}
            columns={[
              {
                key: 'code',
                header: 'Code',
                width: '8rem',
                value: (p) => p.code,
                cell: (p) => <span className="font-mono text-xs">{p.code}</span>,
              },
              {
                key: 'name',
                header: 'Programme',
                value: (p) => p.name,
                cell: (p) => <span className="text-sm">{p.name}</span>,
              },
              {
                key: 'adopt',
                header: '',
                width: '12rem',
                value: () => '',
                fixed: true,
                sortable: false,
                cell: (p) =>
                  mayEdit ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || taken.has(p.code.trim())}
                      onClick={() => void adopt(p)}
                    >
                      {taken.has(p.code.trim())
                        ? `Already in ${fiscalYear}`
                        : `Adopt into ${fiscalYear}`}
                    </Button>
                  ) : null,
              },
            ]}
            rowKey={(p) => p.id}
            searchPlaceholder="Code or programme name"
            emptyTitle=""
            emptyMessage=""
          />
        </Card>
      )}

      {editing !== null && (
        <ProgramForm
          program={editing === 'new' ? null : editing}
          fiscalYear={fiscalYear}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      )}

      <ConfirmDialog
        open={copying}
        onCancel={() => setCopying(false)}
        onConfirm={() => void copyForward()}
        loading={busy}
        title={`Copy the ${fiscalYear - 1} programmes into ${fiscalYear}`}
        confirmLabel="Copy them"
        variant="primary"
        message={
          <>
            <p>
              {lastYear.filter((p) => !taken.has(p.code.trim())).length} programme
              {lastYear.filter((p) => !taken.has(p.code.trim())).length === 1 ? '' : 's'} will be
              added to {fiscalYear}. A code already in {fiscalYear} is left alone, so this is safe
              to run twice.
            </p>
            <p className="mt-2">
              They are COPIES. Renaming one here does not touch the {fiscalYear - 1} record, and
              nothing already appropriated changes - an appropriation carries its own programme
              code and name.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Remove any this year's ordinance did not carry over. A programme with nothing
              appropriated to it shows "Nothing yet" in the Appropriated column.
            </p>
          </>
        }
      />

      <ConfirmDialog
        open={removing !== null}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const p = removing;
          if (!p) return;
          setBusy(true);
          void deactivateMaster(COL.programs, p.id, actorStamp({ uid: 'ui', name: 'ui' }))
            .then(() => {
              toast.success(`${p.code} removed from ${fiscalYear}`);
              setRemoving(null);
            })
            .catch((err: unknown) =>
              toast.error('Could not remove it', err instanceof Error ? err.message : String(err)),
            )
            .finally(() => setBusy(false));
        }}
        loading={busy}
        title={`Remove ${removing?.code ?? ''} from ${fiscalYear}`}
        confirmLabel="Remove"
        variant="danger"
        message={
          <>
            <p>
              It stops being offered when an appropriation is encoded. It is not deleted - master
              data never is - so {fiscalYear} appropriations already made to it are untouched and
              still print its name.
            </p>
            {(appropriatedBy.get(removing?.code ?? '') ?? 0) !== 0 && (
              <p className="mt-2">
                <strong>
                  {formatPeso(appropriatedBy.get(removing?.code ?? '') ?? 0)} has already been
                  appropriated to it this year.
                </strong>{' '}
                Removing it does not undo that. If the appropriation is wrong, correct the
                appropriation.
              </p>
            )}
          </>
        }
      />
    </div>
  );
}

/** Add or edit one programme. Four fields; the year comes from the screen. */
function ProgramForm({
  program,
  fiscalYear,
  busy,
  onCancel,
  onSave,
}: {
  program: Program | null;
  fiscalYear: number;
  busy: boolean;
  onCancel: () => void;
  onSave: (values: {
    code: string;
    name: string;
    officeId: string | null;
    officeName: string;
  }) => void;
}) {
  const [code, setCode] = useState(program?.code ?? '');
  const [name, setName] = useState(program?.name ?? '');
  const [officeId, setOfficeId] = useState<string | null>(program?.officeId ?? null);
  const [officeName, setOfficeName] = useState(program?.officeName ?? '');

  return (
    <Modal
      open
      onClose={onCancel}
      title={program ? `${program.code} - fiscal year ${fiscalYear}` : `New programme for ${fiscalYear}`}
      description="What the ordinance appropriated to, where it named a project or a function rather than an object of expenditure."
      footer={
        <div className="flex gap-2">
          <Button
            variant="primary"
            loading={busy}
            onClick={() => onSave({ code, name, officeId, officeName })}
          >
            Save
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Code"
          required
          htmlFor="pcode"
          hint="As the annex writes it. It is what every appropriation to this programme is matched on."
        >
          <TextInput
            id="pcode"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={Boolean(program)}
            className="font-mono"
            placeholder="8711"
          />
        </Field>

        <Field label="Programme name" required htmlFor="pname" className="sm:col-span-2">
          <TextInput
            id="pname"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Construction of Barangay Health Station, Payauan"
          />
        </Field>

        <Field
          label="Implementing office"
          htmlFor="poffice"
          className="sm:col-span-2"
          hint="Optional. It only pre-fills the office when an appropriation is encoded against this programme."
        >
          <OfficePicker
            id="poffice"
            value={officeId}
            onChange={(v, o) => {
              setOfficeId(v);
              setOfficeName(o?.name ?? '');
            }}
          />
        </Field>
      </div>

      {program && (
        <p className="mt-4 text-xs text-slate-500">
          The code cannot be changed. An appropriation already made carries this code, and changing
          it here would leave that appropriation matched to a programme that no longer exists.
          Remove this one and add the right code instead.
        </p>
      )}
    </Modal>
  );
}
