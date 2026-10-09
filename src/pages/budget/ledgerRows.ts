import type { Appropriation } from '@/types/budget';
import { actKindOfLine } from '@/lib/budgetActs';

/**
 * The Appropriation Ledger's rows. Patch 128.
 *
 * A realignment or an augmentation is ONE act whose lines come to zero: it
 * moves authority between items and adds none. Shown line by line it read as
 * a 10,000 increase to one item and a 10,000 cut to another, each as though
 * it were an appropriation of its own. Neil: "it should not be presented in
 * appro as per item or expense but per authorities ... the effect of both is
 * zero, it should be lump."
 *
 * So the ledger shows each such act once - its authority, the offices it
 * touched, how much it moved, and its net effect (nil). The lines are on the
 * act's own page, and in the registry, where the per-item balances are.
 *
 * Grouped by act kind, authority number and status: a set posts whole, so
 * its lines share a status; the status is in the key only so that a legacy
 * line approved by itself is not hidden inside a group that says otherwise.
 */
export interface LumpInfo {
  actKind: 'REALIGNMENT' | 'AUGMENTATION';
  lines: Appropriation[];
  /** What it moved - the total given up, which equals the total received. */
  moved: number;
  offices: string[];
}

export type LedgerRow = Appropriation & { lump?: LumpInfo };

export function ledgerRows(data: Appropriation[]): LedgerRow[] {
  const groups = new Map<string, Appropriation[]>();
  const order: Array<{ key: string } | { line: Appropriation }> = [];
  for (const a of data) {
    const kind = actKindOfLine(a);
    const ref = (a.authorityReference ?? '').trim();
    if ((kind !== 'REALIGNMENT' && kind !== 'AUGMENTATION') || !ref || a.status === 'CANCELLED') {
      order.push({ line: a });
      continue;
    }
    const key = `${kind}|${ref}|${a.status}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push({ key });
    }
    groups.get(key)!.push(a);
  }

  return order.map((o) => {
    if ('line' in o) return o.line;
    const lines = groups.get(o.key)!;
    const first = lines[0];
    const offices = [...new Set(lines.map((l) => l.officeName).filter(Boolean))];
    const dates = lines
      .map((l) => l.authorityDate)
      .filter(Boolean)
      .sort();
    return {
      ...first,
      id: `lump__${o.key}`,
      amount: lines.reduce((t, l) => t + l.amount, 0),
      officeName: offices.join(', '),
      accountCode: '',
      accountName: '',
      fppCode: '',
      fppName: '',
      expenseClass: [...new Set(lines.map((l) => l.expenseClass))].join(', '),
      authorityDate: dates[0] ?? first.authorityDate,
      lump: {
        actKind: actKindOfLine(first) as LumpInfo['actKind'],
        lines,
        moved: lines.reduce((t, l) => t + (l.amount > 0 ? l.amount : 0), 0),
        offices,
      },
    } as LedgerRow;
  });
}
