import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, getDocs, limit, query, where } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { COL } from '@/lib/collections';
import { formatPeso } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import { StatusBadge } from './ui/Badge';

/**
 * Universal search.
 *
 * Searches by document number and by payee across the transaction
 * collections. Firestore has no full-text search, so this does what Firestore
 * does well - exact and prefix matches on indexed fields - and is honest about
 * it in the placeholder rather than pretending to be a search engine and
 * quietly returning nothing.
 *
 * A prefix match is expressed as a range query: `>= term` and `<= term + `,
 * where  is a very high code point, so "100-26-09" matches every document
 * number beginning with it.
 */

interface Hit {
  id: string;
  kind: string;
  ref: string;
  secondary: string;
  amount?: number;
  status?: string;
  to: string;
}

const PREFIX_END = '';

export function UniversalSearch() {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [searching, setSearching] = useState(false);
  const navigate = useNavigate();

  // Ctrl/Cmd+K, the shortcut anyone who uses software expects.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const trimmed = term.trim();

  useEffect(() => {
    if (trimmed.length < 3) {
      setHits([]);
      return;
    }

    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setSearching(true);
      try {
        const upper = trimmed.toUpperCase();
        const results = await Promise.all([
          searchBy(COL.disbursementVouchers, 'dvNo', upper, 'Disbursement Voucher', '/accounting/disbursements'),
          searchBy(COL.obligations, 'obrNo', upper, 'Obligation', '/budget/obligations'),
          searchBy(COL.jevs, 'jevNo', upper, 'Journal Entry', '/accounting/others'),
          searchBy(COL.checks, 'checkNo', upper, 'Check', '/accounting/checks'),
          searchBy(COL.ada, 'adaNo', upper, 'ADA', '/accounting/ada'),
          searchBy(COL.rcds, 'rcdNo', upper, 'RCD', '/treasury/rcd'),
          searchPayee(trimmed),
        ]);
        if (!cancelled) setHits(results.flat().slice(0, 25));
      } catch (err) {
        console.error('[CFMS] Search failed', err);
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [trimmed]);

  const grouped = useMemo(() => {
    const map = new Map<string, Hit[]>();
    for (const hit of hits) {
      const list = map.get(hit.kind) ?? [];
      list.push(hit);
      map.set(hit.kind, list);
    }
    return [...map.entries()];
  }, [hits]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="hidden items-center gap-2 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-500 hover:bg-slate-50 md:flex"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path
            fillRule="evenodd"
            d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
            clipRule="evenodd"
          />
        </svg>
        Search
        <kbd className="rounded border border-slate-300 bg-slate-50 px-1 text-2xs">Ctrl K</kbd>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 no-print" role="dialog" aria-modal="true">
          <div className="fixed inset-0 bg-navy-950/40" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="relative mx-auto mt-24 w-full max-w-2xl px-4">
            <div className="overflow-hidden rounded-lg bg-white shadow-raised ring-1 ring-slate-900/10">
              <div className="flex items-center gap-2 border-b border-slate-200 px-4">
                <svg className="h-4 w-4 text-slate-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path
                    fillRule="evenodd"
                    d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
                    clipRule="evenodd"
                  />
                </svg>
                <input
                  autoFocus
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                  placeholder="Document number or payee, e.g. 100-26-09-0001"
                  className="w-full border-0 py-3.5 text-sm text-navy-900 placeholder:text-slate-400 focus:ring-0"
                />
                {searching && (
                  <svg className="h-4 w-4 animate-spin text-brand-600" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                )}
              </div>

              <div className="max-h-96 overflow-y-auto">
                {trimmed.length > 0 && trimmed.length < 3 ? (
                  <p className="px-4 py-6 text-center text-sm text-slate-500">Type at least three characters.</p>
                ) : hits.length === 0 && trimmed.length >= 3 && !searching ? (
                  <div className="px-4 py-6 text-center">
                    <p className="text-sm text-slate-600">Nothing matches "{trimmed}".</p>
                    <p className="mt-1 text-xs text-slate-500">
                      Search matches the start of a document number, or the start of a payee name. To search by
                      amount or particulars, open the relevant register and use its own filters.
                    </p>
                  </div>
                ) : (
                  grouped.map(([kind, items]) => (
                    <div key={kind}>
                      <p className="bg-slate-50 px-4 py-1.5 text-2xs font-semibold uppercase tracking-wider text-slate-500">
                        {kind}
                      </p>
                      {items.map((hit) => (
                        <button
                          key={`${hit.kind}-${hit.id}`}
                          onClick={() => {
                            setOpen(false);
                            setTerm('');
                            navigate(hit.to);
                          }}
                          className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-brand-50"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-mono text-sm text-navy-900">{hit.ref}</p>
                            <p className="truncate text-xs text-slate-500">{hit.secondary}</p>
                          </div>
                          {hit.amount !== undefined && (
                            <span className="cbo-amount text-navy-800">{formatPeso(hit.amount)}</span>
                          )}
                          {hit.status && <StatusBadge status={hit.status} />}
                        </button>
                      ))}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

async function searchBy(
  col: string,
  field: string,
  term: string,
  kind: string,
  basePath: string,
): Promise<Hit[]> {
  const snap = await getDocs(
    query(
      collection(db, col),
      where(field, '>=', term),
      where(field, '<=', term + PREFIX_END),
      limit(5),
    ),
  );

  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      kind,
      ref: (data[field] as string) ?? d.id,
      secondary: [
        data.payeeName,
        data.particulars,
        data.dvDate ?? data.obrDate ?? data.jevDate ?? data.checkDate ?? data.adaDate ?? data.rcdDate,
      ]
        .filter(Boolean)
        .map((v, i) => (i === 2 ? formatShortDate(v as string) : String(v)))
        .join(' - ')
        .slice(0, 110),
      amount:
        (data.netAmount as number) ??
        (data.totalAmount as number) ??
        (data.amount as number) ??
        (data.totalDebit as number),
      status: data.status as string | undefined,
      to: `${basePath}/${d.id}`,
    };
  });
}

async function searchPayee(term: string): Promise<Hit[]> {
  // Payee names are stored as entered, so match on the exact case the user
  // typed and on a capitalised variant, which covers the common cases without
  // a separate lowercase index field.
  const variants = [term, term.charAt(0).toUpperCase() + term.slice(1), term.toUpperCase()];
  const seen = new Set<string>();
  const hits: Hit[] = [];

  for (const v of variants) {
    const snap = await getDocs(
      query(
        collection(db, COL.payees),
        where('name', '>=', v),
        where('name', '<=', v + PREFIX_END),
        limit(4),
      ),
    );
    for (const d of snap.docs) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      const data = d.data();
      hits.push({
        id: d.id,
        kind: 'Payee',
        ref: data.name as string,
        secondary: [data.payeeType, data.tin ? `TIN ${data.tin}` : null].filter(Boolean).join(' - '),
        to: `/accounting/index-of-payments?payee=${d.id}`,
      });
    }
    if (hits.length >= 4) break;
  }

  return hits;
}
