import type { Allotment, AroDraft } from '@/types/budget';
import type { Centavos } from '@/types/common';
import { aroDraftWaiting } from '@/lib/budgetEditable';

/**
 * The Allotments screen as ONE register. Patch 112.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE WERE TWO TABLES, AND WHY NOW ONE
 * ---------------------------------------------------------------------------
 * The screen showed "Release orders issued" - one row per Allotment Release
 * Order - and under it the allotment register - one row per line those orders
 * released. Every order appeared twice, once as itself and once per line, and
 * the officer read the same figure in two places to answer one question: what
 * has been released, and on what authority.
 *
 * So the register is now made of DOCUMENTS. A row is one of:
 *
 *   PREPARED       an order prepared and waiting for the Budget Officer -
 *                  in the same table since patch 113, marked by its status
 *   ORDER          an Allotment Release Order, with its lines inside the row
 *   LATER_RELEASE  the release of an amount an order held back
 *   WITHDRAWAL     allotment taken back
 *   NO_ORDER       a line released before orders existed, by an old upload
 *
 * ---------------------------------------------------------------------------
 * THE ORDER THAT CHANGED ITS DATE
 * ---------------------------------------------------------------------------
 * Building the order rows exposed a fault in the old table. Releasing an
 * amount an order held back writes a NEW allotment line carrying the ORDER's
 * number - rightly, so it can be traced to the order that held it. The old
 * table grouped every line by that number, so the release was counted as a
 * line OF the order:
 *
 *   ARO-100-2026-0001 issued 01 Jan, releasing 90,000 and holding 10,000.
 *   The 10,000 released on 08 Oct.
 *   The table then showed ARO-0001 dated 08 Oct, 2 lines, 100,000 released,
 *   nothing held - and PRINTED it that way, which is not the order the Mayor
 *   signed.
 *
 * A later release is recognised by `releasedFromHeld`, which the engine writes
 * on it, and is its own row. The order keeps its own date, and what it HELD AT
 * ISSUE is recovered: the hold still on its line plus whatever has since been
 * released from it - because the engine reduces the hold on the original line
 * as it releases.
 */

export type RegisterKind = 'PREPARED' | 'ORDER' | 'LATER_RELEASE' | 'WITHDRAWAL' | 'NO_ORDER';

/**
 * One line of a register row, as it is shown and printed.
 *
 * Carried as plain figures rather than as the allotment record, because a
 * PREPARED order has no allotment record yet - its lines live on the
 * prepared order until approval writes them. `allotment` is there when the
 * line has been released, for the acts that need it (releasing a hold).
 */
export interface RegisterLine {
  key: string;
  officeName: string;
  fppCode: string;
  fppName: string;
  accountCode: string;
  accountName: string;
  amount: Centavos;
  /** What the line held back when the order was issued (or, prepared, will hold). */
  heldAtIssue: Centavos;
  /** And what it holds now, after any later release. */
  stillHeld: Centavos;
  allotment?: Allotment;
}

export interface RegisterRow {
  key: string;
  kind: RegisterKind;
  /** The ARO number, or the line's own number; empty on a prepared order. */
  reference: string;
  date: string;
  expenseClass: string;
  purpose: string;
  lines: RegisterLine[];
  released: Centavos;
  heldAtIssue: Centavos;
  stillHeld: Centavos;
  /** PREPARED for an order waiting for approval; otherwise the lines' own. */
  status: Allotment['status'] | 'PREPARED';
  /** The prepared order itself, for Edit, Approve and Discard. */
  draft?: AroDraft;
  /** The released lines behind the row, for the detail panel. */
  allotments: Allotment[];
}

/** The release of a held amount, as the engine marks it. */
export function isLaterRelease(a: Allotment): boolean {
  return Boolean(
    a.releasedFromHeld?.allotmentId ||
    /^Release of allotment held for later release\./.test(a.particulars ?? ''),
  );
}

const sum = (xs: number[]) => xs.reduce((t, x) => t + x, 0);

/** Lines of one order in the order they print: by office, then by budget line. */
const byOfficeThenLine = (a: RegisterLine, b: RegisterLine) =>
  a.officeName.localeCompare(b.officeName) || a.fppCode.localeCompare(b.fppCode);

const fromAllotment = (a: Allotment, heldAtIssue: number, stillHeld: number): RegisterLine => ({
  key: a.id,
  officeName: a.officeName ?? '',
  fppCode: a.fppCode ?? '',
  fppName: a.fppName ?? '',
  accountCode: a.accountCode ?? '',
  accountName: a.accountName ?? '',
  amount: a.amount,
  heldAtIssue,
  stillHeld,
  allotment: a,
});


export function buildAllotmentRegister(
  allotments: Allotment[],
  prepared: AroDraft[] = [],
): RegisterRow[] {
  /* What has been released, since, from the hold on each line. */
  const releasedFrom = new Map<string, number>();
  for (const a of allotments) {
    const from = a.releasedFromHeld?.allotmentId;
    if (from && a.status !== 'CANCELLED') {
      releasedFrom.set(from, (releasedFrom.get(from) ?? 0) + a.amount);
    }
  }

  const orders = new Map<string, Allotment[]>();
  const rows: RegisterRow[] = [];

  for (const a of allotments) {
    if (isLaterRelease(a)) {
      rows.push(single(a, 'LATER_RELEASE'));
    } else if (a.amount < 0) {
      rows.push(single(a, 'WITHDRAWAL'));
    } else if (a.aroNo) {
      const list = orders.get(a.aroNo) ?? [];
      list.push(a);
      orders.set(a.aroNo, list);
    } else {
      rows.push(single(a, 'NO_ORDER'));
    }
  }

  for (const [aroNo, list] of orders) {
    const lines = list
      .map((a) => {
        const stillHeld = a.forLaterRelease ?? 0;
        return fromAllotment(a, stillHeld + (releasedFrom.get(a.id) ?? 0), stillHeld);
      })
      .sort(byOfficeThenLine);
    const first = [...list].sort((x, y) => x.allotmentDate.localeCompare(y.allotmentDate))[0];
    rows.push({
      key: `ARO:${aroNo}`,
      kind: 'ORDER',
      reference: aroNo,
      // The order's own date: the earliest of its lines, which share it.
      date: first.allotmentDate,
      expenseClass: first.expenseClass,
      purpose: list.find((l) => l.aroPurpose)?.aroPurpose ?? '',
      lines,
      released: sum(lines.map((l) => l.amount)),
      heldAtIssue: sum(lines.map((l) => l.heldAtIssue)),
      stillHeld: sum(lines.map((l) => l.stillHeld)),
      status: list.every((l) => l.status === 'APPROVED')
        ? 'APPROVED'
        : list.some((l) => l.status === 'DRAFT')
          ? 'DRAFT'
          : list[0].status,
      allotments: list,
    });
  }

  /*
   * PREPARED ORDERS, IN THE SAME TABLE. Patch 113.
   *
   * They sat in a box of their own above the register. They are rows now,
   * marked Prepared, with no ARO number - it is issued on approval - and
   * nothing in the page's "released" total, which counts released lines only.
   */
  for (const d of prepared.filter((d) => aroDraftWaiting(d))) {
    const lines: RegisterLine[] = (d.lines ?? [])
      .map((l, i) => ({
        key: `${d.id}:${i}`,
        officeName: l.officeName ?? '',
        fppCode: l.fppCode ?? '',
        fppName: l.fppName ?? '',
        accountCode: l.accountCode ?? '',
        accountName: l.accountName ?? '',
        amount: l.amount ?? 0,
        heldAtIssue: l.forLaterRelease ?? 0,
        stillHeld: l.forLaterRelease ?? 0,
      }))
      .sort(byOfficeThenLine);
    rows.push({
      key: `DRAFT:${d.id}`,
      kind: 'PREPARED',
      reference: '',
      date: d.date,
      expenseClass: d.expenseClass,
      purpose: d.purpose ?? '',
      lines,
      released: sum(lines.map((l) => l.amount)),
      heldAtIssue: sum(lines.map((l) => l.heldAtIssue)),
      stillHeld: sum(lines.map((l) => l.stillHeld)),
      status: 'PREPARED',
      draft: d,
      allotments: [],
    });
  }

  /*
   * What is waiting comes first - it is the part of the table someone has to
   * act on - then everything else newest first; on one day, the later number
   * first.
   */
  const rank = (r: RegisterRow) => (r.kind === 'PREPARED' || r.status === 'DRAFT' ? 0 : 1);
  return rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      b.date.localeCompare(a.date) ||
      b.reference.localeCompare(a.reference),
  );
}

function single(a: Allotment, kind: RegisterKind): RegisterRow {
  const held = kind === 'NO_ORDER' ? (a.forLaterRelease ?? 0) : 0;
  return {
    key: `LINE:${a.id}`,
    kind,
    reference:
      kind === 'LATER_RELEASE' ? (a.aroNo ?? a.allotmentNo ?? '') : a.allotmentNo || a.aroNo || '',
    date: a.allotmentDate,
    expenseClass: a.expenseClass,
    purpose:
      kind === 'LATER_RELEASE'
        ? (a.releasedFromHeld?.reason ??
          (a.particulars ?? '').replace(/^Release of allotment held for later release\.\s*/, ''))
        : (a.particulars ?? ''),
    lines: [fromAllotment(a, held, held)],
    released: a.amount,
    heldAtIssue: held,
    stillHeld: held,
    status: a.status,
    allotments: [a],
  };
}

/**
 * The later releases made from an order's holds - for the order's detail, so
 * the officer reading it sees where the held amount went.
 */
export function laterReleasesOf(order: RegisterRow, rows: RegisterRow[]): RegisterRow[] {
  const ids = new Set(order.allotments.map((a) => a.id));
  return rows.filter(
    (r) =>
      r.kind === 'LATER_RELEASE' &&
      r.allotments.some((a) =>
        a.releasedFromHeld?.allotmentId
          ? ids.has(a.releasedFromHeld.allotmentId)
          : order.reference !== '' && a.aroNo === order.reference,
      ),
  );
}

/** A budget line as it reads on the register: its object, or its programme. */
export function budgetLineText(a: {
  accountCode?: string;
  accountName?: string;
  fppCode?: string;
  fppName?: string;
}): { code: string; name: string } {
  if (a.accountCode) return { code: a.accountCode, name: a.accountName ?? '' };
  /*
   * A line appropriated BY PROGRAMME carries no object code, on purpose - the
   * ordinance named a project. The old register printed nothing in the
   * Account column for it, which read as a line released against nothing.
   */
  return { code: '', name: a.fppName || a.fppCode || '' };
}
