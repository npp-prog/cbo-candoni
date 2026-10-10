import { useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { useFilters } from '@/context/FilterContext';
import { useAuth } from '@/auth/AuthProvider';
import { useAccounts } from '@/data/queries';
import { useDocument } from '@/hooks/useFirestore';
import { COL } from '@/lib/collections';
import { engine } from '@/lib/engine';
import { formatPeso, parsePeso } from '@/lib/money';
import { formatLongDate } from '@/lib/dates';
import { ACCOUNTING_SETUP_TABS } from '@/layout/sections';
import { fundLabel } from '../budget/Obligations';
import {
  PRIOR_TB_LABELS,
  compareWithOpening,
  netByCode,
  openNominalAccounts,
  priorTbId,
  type PriorTbKind,
  type PriorTbLine,
} from '@/lib/priorTrialBalance';

/**
 * Patch 169 - Accounting > Setup > Prior Year Trial Balances.
 *
 * The preceding year's pre-closing and post-closing trial balances, uploaded
 * so the financial statements have a comparative column in the year CFMS
 * takes over. See src/lib/priorTrialBalance.ts.
 *
 * The post-closing trial balance must agree, account by account, with the
 * Opening Balances posted for this year: it is the same position, seen from
 * the other side of 31 December.
 */

export interface StoredPriorTb {
  fiscalYear: number;
  fundCode: string;
  kind: PriorTbKind;
  asOfDate: string;
  fileName?: string | null;
  lines: Array<{
    accountCode: string;
    accountName: string;
    fileTitle?: string;
    debit: number;
    credit: number;
  }>;
  lineCount: number;
  totalDebit: number;
  namesDiffer?: number;
  openingChecked?: boolean;
  openingJevNo?: string | null;
  uploadedAt?: string;
  uploadedBy?: { name?: string };
}

interface Draft {
  fileName: string;
  lines: Array<PriorTbLine & { chartName?: string; problem?: string; nameDiffers?: boolean }>;
}

export default function PriorTrialBalances() {
  const { fiscalYear, fundCode } = useFilters();
  const tbYear = fiscalYear - 1;
  const { hasRole } = useAuth();
  const canSave = hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT');

  const accounts = useAccounts(false);
  const byCode = useMemo(
    () => new Map(accounts.data.map((a) => [String(a.code), a])),
    [accounts.data],
  );

  const pre = useDocument<StoredPriorTb>(
    COL.priorTrialBalances,
    priorTbId(tbYear, fundCode, 'PRE'),
  );
  const post = useDocument<StoredPriorTb>(
    COL.priorTrialBalances,
    priorTbId(tbYear, fundCode, 'POST'),
  );

  /* The Opening Balances of the filter year, to check the post-closing against. */
  const marker = useDocument<{ jevId?: string; jevNo?: string; asOfDate?: string }>(
    COL.openingBalances,
    `${fiscalYear}__${fundCode}`,
  );
  const openingJev = useDocument<{
    lines?: Array<{ accountCode: string; debit?: number; credit?: number }>;
  }>(COL.jevs, marker.data?.jevId ?? null);
  const openingNet = useMemo(
    () => (marker.data ? netByCode(openingJev.data?.lines ?? []) : null),
    [marker.data, openingJev.data],
  );

  return (
    <>
      <PageHeader
        title="Prior year trial balances"
        breadcrumbs={[{ label: 'Accounting' }, { label: 'Prior year trial balances' }]}
        subtitle={`${fundLabel(fundCode)} - the trial balances of ${tbYear}, for the comparative column of the ${fiscalYear} financial statements.`}
      />
      <SectionTabs tabs={ACCOUNTING_SETUP_TABS} />

      <Alert tone="info" className="mb-4">
        <p>
          The {fiscalYear} financial statements print {tbYear} beside {fiscalYear}. Where the
          General Ledger has no {tbYear} of its own - the year before CFMS - the comparative is read
          from these two trial balances: the <strong>pre-closing</strong> one for the Statement of
          Financial Performance, the <strong>post-closing</strong> one for the Statement of
          Financial Position. Nothing here is posted to the General Ledger.
        </p>
        <p className="mt-1">
          The file: an Excel or CSV sheet with columns Account Code, Account Title, Debit and
          Credit. Every code must be in the Chart of Accounts and the debits must equal the credits.
          The post-closing trial balance must agree, account by account, with the Opening Balances
          of {fiscalYear}.
        </p>
      </Alert>

      <div className="grid gap-4">
        {(['PRE', 'POST'] as PriorTbKind[]).map((kind) => (
          <TbCard
            key={kind}
            kind={kind}
            tbYear={tbYear}
            fiscalYear={fiscalYear}
            fundCode={fundCode}
            stored={(kind === 'PRE' ? pre : post).data}
            loading={(kind === 'PRE' ? pre : post).loading}
            canSave={canSave}
            byCode={byCode}
            openingNet={kind === 'POST' ? openingNet : null}
            openingJevNo={marker.data?.jevNo ?? null}
          />
        ))}
      </div>
    </>
  );
}

function TbCard({
  kind,
  tbYear,
  fiscalYear,
  fundCode,
  stored,
  loading,
  canSave,
  byCode,
  openingNet,
  openingJevNo,
}: {
  kind: PriorTbKind;
  tbYear: number;
  fiscalYear: number;
  fundCode: string;
  stored: StoredPriorTb | null;
  loading: boolean;
  canSave: boolean;
  byCode: Map<string, { name: string; postable?: boolean }>;
  openingNet: Map<string, number> | null;
  openingJevNo: string | null;
}) {
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const readFile = async (file: File) => {
    try {
      const book = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: false });
      const sheet = book.Sheets[book.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
      const find = (row: Record<string, unknown>, patterns: RegExp[]) => {
        for (const key of Object.keys(row)) if (patterns.some((p) => p.test(key))) return row[key];
        return undefined;
      };
      const lines: Draft['lines'] = [];
      for (const raw of json) {
        const code = String(find(raw, [/account\s*code/i, /^code$/i, /uacs/i]) ?? '')
          .replace(/[\s-]/g, '')
          .trim();
        if (!/^\d{5,}$/.test(code)) continue;
        const title = String(
          find(raw, [/account\s*(title|name)/i, /^title$/i, /^particulars$/i, /^name$/i]) ?? '',
        ).trim();
        const debit = parsePeso(String(find(raw, [/debit/i, /^dr$/i]) ?? '0')) ?? 0;
        const credit = parsePeso(String(find(raw, [/credit/i, /^cr$/i]) ?? '0')) ?? 0;
        if (!debit && !credit) continue;
        const account = byCode.get(code);
        lines.push({
          accountCode: code,
          accountName: title,
          debit,
          credit,
          chartName: account?.name,
          problem: !account
            ? 'Not in the Chart of Accounts'
            : account.postable === false
              ? 'Grouping account'
              : debit < 0 || credit < 0
                ? 'Negative amount'
                : undefined,
          nameDiffers:
            !!account && !!title && title.toLowerCase() !== String(account.name).toLowerCase(),
        });
      }
      if (!lines.length) {
        toast.error(
          'No balances found',
          'No row had an account code and an amount. The sheet needs Account Code, Debit and Credit columns.',
        );
        return;
      }
      setDraft({ fileName: file.name, lines });
    } catch (err) {
      toast.error('Could not read that file', err instanceof Error ? err.message : String(err));
    }
  };

  const shown = draft?.lines ?? null;
  const totals = useMemo(() => {
    const src = shown ?? stored?.lines ?? [];
    return {
      debit: src.reduce((s, l) => s + l.debit, 0),
      credit: src.reduce((s, l) => s + l.credit, 0),
    };
  }, [shown, stored]);
  const problems = shown?.filter((l) => l.problem) ?? [];
  const net = useMemo(() => netByCode(shown ?? stored?.lines ?? []), [shown, stored]);
  const openNominal = kind === 'POST' ? openNominalAccounts(net) : [];
  const diffs = useMemo(
    () => (kind === 'POST' && openingNet ? compareWithOpening(net, openingNet) : []),
    [kind, net, openingNet],
  );
  const balanced = totals.debit === totals.credit && totals.debit > 0;
  const savable =
    canSave &&
    !!draft &&
    balanced &&
    problems.length === 0 &&
    openNominal.length === 0 &&
    diffs.length === 0;

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const r = await engine.savePriorTrialBalance({
        fiscalYear: tbYear,
        fundCode,
        kind,
        asOfDate: `${tbYear}-12-31`,
        fileName: draft.fileName,
        lines: draft.lines.map((l) => ({
          accountCode: l.accountCode,
          accountName: l.accountName,
          debit: l.debit,
          credit: l.credit,
        })),
      });
      toast.success(
        `${PRIOR_TB_LABELS[kind]} saved`,
        `${r.lineCount} accounts, ${formatPeso(r.total)}.`,
      );
      setDraft(null);
    } catch (err) {
      toast.error('Not saved', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const rows = shown ?? stored?.lines ?? [];

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-navy-900">
            {PRIOR_TB_LABELS[kind]}, {tbYear}
          </h2>
          <p className="text-xs text-slate-500">
            {kind === 'PRE'
              ? `Read for the ${tbYear} column of the Statement of Financial Performance.`
              : `Read for the ${tbYear} column of the Statement of Financial Position. Must agree with the Opening Balances of ${fiscalYear}.`}
          </p>
        </div>
        {canSave && (
          <div className="flex gap-2">
            <input
              ref={fileInput}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void readFile(f);
                e.target.value = '';
              }}
            />
            {draft && (
              <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                Discard
              </Button>
            )}
            <Button
              variant={draft ? 'secondary' : 'primary'}
              size="sm"
              onClick={() => fileInput.current?.click()}
            >
              {stored || draft ? 'Upload another file' : 'Upload'}
            </Button>
            {draft && (
              <Button
                variant="primary"
                size="sm"
                loading={saving}
                disabled={!savable}
                onClick={() => void save()}
              >
                Save
              </Button>
            )}
          </div>
        )}
      </div>

      {loading ? null : !draft && !stored ? (
        <p className="mt-3 text-sm text-slate-500">Not uploaded.</p>
      ) : (
        <>
          <div className="mt-3 space-y-2">
            {draft ? (
              <p className="text-xs text-slate-600">
                Read from <strong>{draft.fileName}</strong> - not yet saved.
              </p>
            ) : stored ? (
              <p className="text-xs text-slate-600">
                Saved {stored.uploadedAt ? formatLongDate(stored.uploadedAt.slice(0, 10)) : ''}
                {stored.uploadedBy?.name ? ` by ${stored.uploadedBy.name}` : ''}
                {stored.fileName ? ` from ${stored.fileName}` : ''} - {stored.lineCount} accounts.
                {kind === 'POST' &&
                  (stored.openingChecked
                    ? ` Checked against the Opening Balances of ${fiscalYear} (JEV ${stored.openingJevNo ?? ''}).`
                    : ` The Opening Balances of ${fiscalYear} were not yet posted when it was saved.`)}
              </p>
            ) : null}
            {!balanced && (
              <Alert tone="error">
                Does not foot: debits {formatPeso(totals.debit)}, credits{' '}
                {formatPeso(totals.credit)}.
              </Alert>
            )}
            {problems.length > 0 && (
              <Alert tone="error">
                {problems.length} line{problems.length === 1 ? '' : 's'} cannot be taken - marked
                below. Correct the codes in the file, or add the accounts to the Chart of Accounts.
              </Alert>
            )}
            {openNominal.length > 0 && (
              <Alert tone="error">
                A post-closing trial balance has no revenue or expense left open, but{' '}
                {openNominal.slice(0, 8).join(', ')}
                {openNominal.length > 8 ? ` and ${openNominal.length - 8} more` : ''} carry a
                balance. Is this the pre-closing one?
              </Alert>
            )}
            {kind === 'POST' && openingNet === null && (
              <Alert tone="warning">
                The Opening Balances of {fiscalYear} are not yet posted, so this cannot be checked
                against them. It will be, when it is next uploaded after they are.
              </Alert>
            )}
            {kind === 'POST' && openingNet && diffs.length > 0 && (
              <Alert
                tone="error"
                title={`Does not agree with the Opening Balances of ${fiscalYear}`}
              >
                <p className="mb-2">
                  {diffs.length} account{diffs.length === 1 ? '' : 's'} differ from JEV{' '}
                  {openingJevNo} (debit less credit):
                </p>
                <table className="w-full text-xs">
                  <thead>
                    <tr>
                      <th className="text-left">Account</th>
                      <th className="px-2 text-right">Trial balance</th>
                      <th className="px-2 text-right">Opening balances</th>
                      <th className="px-2 text-right">Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diffs.slice(0, 50).map((d) => (
                      <tr key={d.accountCode}>
                        <td>
                          {d.accountCode} {byCode.get(d.accountCode)?.name ?? ''}
                        </td>
                        <td className="px-2 text-right tabular-nums">{formatPeso(d.trialBalance)}</td>
                        <td className="px-2 text-right tabular-nums">{formatPeso(d.opening)}</td>
                        <td className="px-2 text-right tabular-nums">{formatPeso(d.difference)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Alert>
            )}
            {kind === 'POST' && openingNet && diffs.length === 0 && balanced && (
              <Alert tone="success">
                Agrees with the Opening Balances of {fiscalYear} (JEV {openingJevNo}), account by
                account.
              </Alert>
            )}
          </div>

          <div className="mt-3 max-h-[28rem] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white">
                <tr>
                  <th className="cbo-th">Account</th>
                  <th className="cbo-th text-right">Debit</th>
                  <th className="cbo-th text-right">Credit</th>
                  {draft && <th className="cbo-th" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((l, i) => {
                  const d = draft ? (l as Draft['lines'][number]) : null;
                  const name = d ? (d.chartName ?? d.accountName) : l.accountName;
                  return (
                    <tr key={`${l.accountCode}-${i}`} className={d?.problem ? 'bg-rose-50' : ''}>
                      <td className="cbo-td">
                        <span className="text-xs text-slate-500">{l.accountCode}</span> {name}
                        {d?.nameDiffers && (
                          <span className="block text-2xs text-amber-700">
                            File: {d.accountName}
                          </span>
                        )}
                      </td>
                      <td className="cbo-td cbo-amount">
                        {l.debit ? formatPeso(l.debit, { symbol: false }) : ''}
                      </td>
                      <td className="cbo-td cbo-amount">
                        {l.credit ? formatPeso(l.credit, { symbol: false }) : ''}
                      </td>
                      {draft && (
                        <td className="cbo-td text-xs text-rose-700">{d?.problem ?? ''}</td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td className="cbo-td">Total</td>
                  <td className="cbo-td cbo-amount">
                    {formatPeso(totals.debit, { symbol: false })}
                  </td>
                  <td className="cbo-td cbo-amount">
                    {formatPeso(totals.credit, { symbol: false })}
                  </td>
                  {draft && <td className="cbo-td" />}
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
