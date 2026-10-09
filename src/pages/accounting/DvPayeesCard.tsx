import { useMemo, useRef, useState } from 'react';
import { Card, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { AmountInput, TextInput } from '@/components/ui/Field';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';
import { PayeePicker } from '@/components/pickers';
import { NewPayeeModal } from '@/components/pickers/NewPayeeModal';
import { useAuth } from '@/auth/AuthProvider';
import { useEmployees, usePayees } from '@/data/queries';
import { readSheet } from '@/lib/spreadsheet';
import { formatPeso } from '@/lib/money';
import { checkDvPayees } from '@/lib/accounting-rules';
import { PAYEE_CREATOR_ROLES } from '@/lib/payees';
import { matchPayees, parsePayeeSheet } from './dvPayees';
import { DvPayeeModal } from './DvPayeeModal';

/**
 * The payees of a "Payee, et al." voucher. Patch 138. See dvPayees.ts for the
 * whole design.
 */

export interface DvPayeeRow {
  payeeId: string | null;
  payeeName: string;
  accountNumber: string;
  amount: number;
  /** As the uploaded sheet named them, while not yet matched to the master list. */
  sheetName?: string;
  tin?: string;
  /** The sheet's account differs from the master record's. */
  accountDiffers?: boolean;
}

export function DvPayeesCard({
  rows,
  onChange,
  netAmount,
  readOnly,
}: {
  rows: DvPayeeRow[];
  onChange: (rows: DvPayeeRow[]) => void;
  netAmount: number;
  readOnly: boolean;
}) {
  const toast = useToast();
  const { hasRole } = useAuth();
  const payees = usePayees();
  const employees = useEmployees();
  const fileRef = useRef<HTMLInputElement>(null);
  // The latest list, for "Add and next": several rows are added before the card re-renders.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const [adding, setAdding] = useState<number | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const mayAdd = hasRole(...PAYEE_CREATOR_ROLES);

  const accountOf = useMemo(() => {
    const emp = new Map(employees.data.map((e) => [e.id, e.bankAccountNumber ?? '']));
    const byId = new Map(payees.data.map((p) => [p.id, p]));
    return (payeeId: string) => {
      const p = byId.get(payeeId);
      if (!p) return '';
      return (p.employeeId ? emp.get(p.employeeId) : '') || p.bankAccountNumber || '';
    };
  }, [payees.data, employees.data]);

  const total = rows.reduce((t, r) => t + (r.amount ?? 0), 0);
  const check = useMemo(() => checkDvPayees(rows, netAmount), [rows, netAmount]);

  const set = (i: number, patch: Partial<DvPayeeRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const upload = async (file: File) => {
    try {
      const sheet = await readSheet(file);
      const parsed = parsePayeeSheet(sheet);
      if (parsed.problems.length) {
        toast.error('Some lines were not read', parsed.problems.slice(0, 4).join(' '));
      }
      if (parsed.rows.length === 0) return;
      const matched = matchPayees(parsed.rows, payees.data, employees.data);
      onChange(
        matched.map((m) => ({
          payeeId: m.payeeId,
          payeeName: m.payeeName,
          accountNumber: m.accountNumber,
          amount: m.amount,
          sheetName: m.payeeId ? undefined : m.name,
          tin: m.tin || undefined,
          accountDiffers: m.accountDiffers,
        })),
      );
      const left = matched.filter((m) => !m.payeeId).length;
      toast.success(
        `${matched.length} payees read`,
        left
          ? `${left} not on the master list - add each with "Add to master list".`
          : 'All found on the master list.',
      );
    } catch (err) {
      toast.error('The file could not be read', err instanceof Error ? err.message : String(err));
    }
  };

  const template = () => {
    const blob = new Blob(['Name,ATM No.,Amount,TIN\r\n'], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'payees-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card
      title={`Payees (et al.) - ${rows.length}`}
      subtitle="Each payee's share of the NET amount and the ATM / account the bank credits. The ADA pays the net; the bank splits it into these accounts."
      actions={
        !readOnly ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" onClick={template}>
              Template
            </Button>
            <Button size="sm" onClick={() => fileRef.current?.click()}>
              Upload list
            </Button>
            <Button size="sm" variant="primary" onClick={() => setAddingNew(true)}>
              Add a payee
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
                e.target.value = '';
              }}
            />
          </div>
        ) : undefined
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-600">
            <tr>
              <th className="w-10 px-2 py-1.5 font-medium">#</th>
              <th className="px-2 py-1.5 font-medium" style={{ minWidth: '18rem' }}>
                Payee
              </th>
              <th className="px-2 py-1.5 font-medium" style={{ minWidth: '12rem' }}>
                ATM / account no.
              </th>
              <th className="px-2 py-1.5 text-right font-medium" style={{ minWidth: '10rem' }}>
                Share of the net
              </th>
              {!readOnly && <th className="w-8" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r, i) => (
              <tr key={i} className={!r.payeeId ? 'bg-amber-50' : undefined}>
                <td className="px-2 py-1.5 text-xs text-slate-500">{i + 1}</td>
                <td className="px-2 py-1.5">
                  {readOnly ? (
                    r.payeeName
                  ) : (
                    <>
                      <PayeePicker
                        allowAdd
                        value={r.payeeId}
                        onChange={(v, p) =>
                          set(i, {
                            payeeId: v,
                            payeeName: p?.name ?? '',
                            sheetName: undefined,
                            accountNumber: r.accountNumber || (v ? accountOf(v) : ''),
                            accountDiffers: false,
                          })
                        }
                      />
                      {!r.payeeId && r.sheetName && (
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-amber-800">
                          <span>
                            On the sheet as <strong>{r.sheetName}</strong> - not on the master list.
                          </span>
                          {mayAdd && (
                            <Button size="sm" variant="secondary" onClick={() => setAdding(i)}>
                              Add to master list
                            </Button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </td>
                <td className="px-2 py-1.5">
                  {readOnly ? (
                    <span className="font-mono text-xs">{r.accountNumber}</span>
                  ) : (
                    <TextInput
                      value={r.accountNumber}
                      onChange={(e) =>
                        set(i, { accountNumber: e.target.value, accountDiffers: false })
                      }
                      className="py-1 font-mono text-xs"
                    />
                  )}
                  {r.accountDiffers && (
                    <Badge tone="amber" className="mt-1">
                      Differs from the payee record
                    </Badge>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right">
                  {readOnly ? (
                    <span className="font-mono">{formatPeso(r.amount, { symbol: false })}</span>
                  ) : (
                    <AmountInput
                      value={r.amount || null}
                      onChange={(v) => set(i, { amount: v ?? 0 })}
                    />
                  )}
                </td>
                {!readOnly && (
                  <td className="px-2 py-1.5 text-center">
                    <button
                      type="button"
                      aria-label="Remove payee"
                      className="rounded p-1 text-slate-400 hover:text-rose-600"
                      onClick={() => onChange(rows.filter((_, j) => j !== i))}
                    >
                      &times;
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-navy-800 font-semibold">
              <td className="px-2 py-1.5" colSpan={3}>
                Total - net amount of the voucher {formatPeso(netAmount, { symbol: false })}
              </td>
              <td
                className={`px-2 py-1.5 text-right font-mono ${total !== netAmount ? 'text-rose-600' : ''}`}
              >
                {formatPeso(total, { symbol: false })}
              </td>
              {!readOnly && <td />}
            </tr>
          </tfoot>
        </table>
      </div>

      {rows.length > 0 && !check.ok && (
        <Alert
          tone={readOnly ? 'error' : 'warning'}
          className="mt-3"
          title="Not yet ready to submit"
        >
          <ul className="list-inside list-disc space-y-0.5">
            {check.violations.map((v, i) => (
              <li key={i}>{v.message}</li>
            ))}
          </ul>
        </Alert>
      )}
      {rows.length === 0 && (
        <p className="mt-3 text-xs text-slate-500">
          Upload the list (Name, ATM No., Amount - TIN optional; use Template for the headings) or
          press Add a payee for each one.
        </p>
      )}

      {addingNew && (
        <DvPayeeModal
          existing={payees.data}
          listedIds={rows.map((r) => r.payeeId).filter((id): id is string => Boolean(id))}
          remaining={netAmount - total}
          accountOf={accountOf}
          mayCreate={mayAdd}
          onAdd={(row) => {
            const next = [...rowsRef.current, row];
            rowsRef.current = next;
            onChange(next);
          }}
          onClose={() => setAddingNew(false)}
        />
      )}

      {adding !== null && rows[adding] && (
        <NewPayeeModal
          initialName={rows[adding].sheetName ?? rows[adding].payeeName}
          initialTin={rows[adding].tin ?? ''}
          initialAccountNumber={rows[adding].accountNumber}
          initialPayeeType="EMPLOYEE"
          existing={payees.data}
          onClose={() => setAdding(null)}
          onCreated={(p) => {
            set(adding, {
              payeeId: p.id,
              payeeName: p.name,
              sheetName: undefined,
              accountNumber: rows[adding].accountNumber || p.bankAccountNumber || '',
            });
            setAdding(null);
          }}
        />
      )}
    </Card>
  );
}
