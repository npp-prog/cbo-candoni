import type {
  Appropriation,
  AppropriationKind,
  AugmentationDraft,
  Ordinance,
} from '@/types/budget';
import type { Centavos } from '@/types/common';

/**
 * The ordinance as a document, read from the lines that name it. Patch 119.
 *
 * ---------------------------------------------------------------------------
 * ONE RECORD, AND THE LINES THAT BELONG TO IT
 * ---------------------------------------------------------------------------
 * Since patch 112 an ordinance uploaded from a file lands as draft lines that
 * are approved together, keyed on the file's reference. Patch 119 gives the
 * ordinance a record of its own, recorded FIRST, that the lines are then
 * typed or uploaded into and the scanned ordinance attached to - so the
 * office works the way it does on paper: the ordinance arrives, its lines are
 * encoded under it, and it is printed on LBP Form No. 2 for signature before
 * it becomes authority.
 *
 * A line belongs to an ordinance when it is in the same year and fund, of the
 * same kind, and names the ordinance's number as its authority. Nothing new
 * is written on the line for that: the authority reference is what the office
 * reads, and a line recorded before this patch under the right number is on
 * its ordinance without migration.
 *
 * A REALIGNMENT ordinance is the exception, because its lines are prepared as
 * one set before they are posted (patch 112). While the set waits, the
 * ordinance's lines are the set's; once posted, they are ledger lines like
 * any other.
 */

/** The reference made safe for a document id, as the engine makes it. */
export function slugReference(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** The id an ordinance is stored under - so the same one cannot be recorded twice. */
export function ordinanceId(o: {
  fiscalYear: number;
  fundCode: string;
  kind: string;
  reference: string;
}): string {
  return `${o.fiscalYear}__${o.fundCode}__${o.kind}__${slugReference(o.reference)}`;
}

/** Whether a ledger line is on this ordinance. */
export function lineBelongsTo(line: Appropriation, o: Ordinance): boolean {
  return (
    line.fiscalYear === o.fiscalYear &&
    line.fundCode === o.fundCode &&
    line.kind === o.kind &&
    (line.authorityReference ?? '').trim() === o.reference.trim() &&
    line.status !== 'CANCELLED'
  );
}

/** Whether a prepared set (a realignment waiting to be posted) is this ordinance's. */
export function setBelongsTo(set: AugmentationDraft, o: Ordinance): boolean {
  return (
    o.kind === 'REALIGNMENT' &&
    set.fiscalYear === o.fiscalYear &&
    set.fundCode === o.fundCode &&
    set.instrument === 'REALIGNMENT' &&
    (set.authorityReference ?? '').trim() === o.reference.trim()
  );
}

export type OrdinanceStage = 'EMPTY' | 'DRAFT' | 'PARTLY' | 'APPROVED';

export interface OrdinanceSummary {
  ordinance: Ordinance;
  lines: Appropriation[];
  sets: AugmentationDraft[];
  draftCount: number;
  approvedCount: number;
  /** Lines that still wait: draft ledger lines, or a prepared set's lines. */
  waitingCount: number;
  /** The authority the ordinance enacts: the approved lines' total (positive side, for a realignment). */
  approvedTotal: Centavos;
  /** What is recorded and not yet approved. */
  draftTotal: Centavos;
  stage: OrdinanceStage;
}

const positive = (n: number) => (n > 0 ? n : 0);

export function summariseOrdinance(
  o: Ordinance,
  appropriations: Appropriation[],
  sets: AugmentationDraft[],
): OrdinanceSummary {
  const lines = appropriations.filter((l) => lineBelongsTo(l, o));
  const own = sets.filter((s) => setBelongsTo(s, o));
  const drafts = lines.filter((l) => l.status === 'DRAFT');
  const approved = lines.filter((l) => l.status === 'APPROVED');
  const realign = o.kind === 'REALIGNMENT';

  const setLines = own.flatMap((s) => s.lines ?? []);
  const draftTotal =
    drafts.reduce((t, l) => t + (realign ? positive(l.amount) : l.amount), 0) +
    setLines.reduce((t, l) => t + positive(l.amount), 0);
  const approvedTotal = approved.reduce((t, l) => t + (realign ? positive(l.amount) : l.amount), 0);
  const waitingCount = drafts.length + setLines.length;

  const stage: OrdinanceStage =
    approved.length === 0 && waitingCount === 0
      ? 'EMPTY'
      : approved.length === 0
        ? 'DRAFT'
        : waitingCount > 0
          ? 'PARTLY'
          : 'APPROVED';

  return {
    ordinance: o,
    lines,
    sets: own,
    draftCount: drafts.length,
    approvedCount: approved.length,
    waitingCount,
    approvedTotal,
    draftTotal,
    stage,
  };
}

export const STAGE_LABELS: Record<OrdinanceStage, string> = {
  EMPTY: 'No lines yet',
  DRAFT: 'Recorded - not yet approved',
  PARTLY: 'Partly approved',
  APPROVED: 'Approved',
};

/** The kinds an ordinance can be. An augmentation is not one - it is signed by the LCE, not enacted. */
export const ORDINANCE_KINDS: Array<{ value: AppropriationKind; label: string; hint: string }> = [
  {
    value: 'ORIGINAL',
    label: 'Original - the annual budget',
    hint: 'The appropriation ordinance for the year.',
  },
  {
    value: 'SUPPLEMENTAL',
    label: 'Supplemental budget',
    hint: 'New authority from new revenue, enacted during the year.',
  },
  {
    value: 'CONTINUING',
    label: 'Continuing appropriation',
    hint: 'Prior-year authority carried forward.',
  },
  {
    value: 'REALIGNMENT',
    label: 'Realignment',
    hint: 'Authority moved across expense classes by ordinance. Its lines are prepared as one set and posted together.',
  },
];
