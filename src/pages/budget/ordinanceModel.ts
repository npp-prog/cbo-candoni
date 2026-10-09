import type { Appropriation, AugmentationDraft, Ordinance } from '@/types/budget';
import {
  ACT_KINDS,
  actId,
  actKindOfInstrument,
  actKindOfLine,
  coverEncoded,
  coverOriginal,
  coverShortfall,
  fundingBasis,
  slugReference,
  type Cover,
  type FundingBasis,
  type SourceEntry,
} from '@/lib/budgetActs';
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

/*
 * The id and the slug moved to lib/budgetActs.ts in patch 123, shared with
 * the engine, which now reads the act when it approves. Re-exported here so
 * the screens that already import them keep working.
 */
export { slugReference };
export const ordinanceId = actId;

/** Acts whose lines are prepared as ONE set that comes to zero. */
export const isSetAct = (kind: string) => kind === 'REALIGNMENT' || kind === 'AUGMENTATION';

/** Whether a ledger line is on this ordinance. */
export function lineBelongsTo(line: Appropriation, o: Ordinance): boolean {
  return (
    line.fiscalYear === o.fiscalYear &&
    line.fundCode === o.fundCode &&
    actKindOfLine(line) === o.kind &&
    (line.authorityReference ?? '').trim() === o.reference.trim() &&
    line.status !== 'CANCELLED'
  );
}

/** Whether a prepared set (a realignment waiting to be posted) is this ordinance's. */
export function setBelongsTo(set: AugmentationDraft, o: Ordinance): boolean {
  return (
    isSetAct(o.kind) &&
    set.fiscalYear === o.fiscalYear &&
    set.fundCode === o.fundCode &&
    actKindOfInstrument(set.instrument) === o.kind &&
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
  const realign = isSetAct(o.kind);

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

/** The kinds of act. Patch 123 added the augmentation - not an ordinance, but a document all the same. */
export const ORDINANCE_KINDS = ACT_KINDS.map((k) => ({ value: k.value, label: k.label, hint: k.hint }));

// ---------------------------------------------------------------------------
// Ready to approve? Patch 123.
// ---------------------------------------------------------------------------

export interface ActReadiness {
  /** The signed copy is attached. */
  documented: boolean;
  basis: FundingBasis;
  /** For an act financed from outside itself; null for a realignment or augmentation. */
  cover: Cover | null;
  /** What it takes from, for a realignment or augmentation - its own source. */
  takenFrom: number;
  ready: boolean;
  /** Why not, in the order they need doing. */
  problems: string[];
}

/**
 * The screen's reading of what the engine will check (functions/src/budget/
 * actGate.ts) - so Approve is offered only when it will go through, and the
 * page says what is missing before anyone presses it.
 */
export function actReadiness(input: {
  summary: OrdinanceSummary;
  attachmentCount: number;
  appropriations: Appropriation[];
  sources: SourceEntry[];
  estimatedRevenue: number;
}): ActReadiness {
  const o = input.summary.ordinance;
  const basis = fundingBasis(o.kind);
  const problems: string[] = [];
  const documented = input.attachmentCount > 0;
  if (!documented) {
    const doc = ACT_KINDS.find((k) => k.value === o.kind)?.document ?? 'signed copy';
    problems.push(`Attach the ${doc} on Supporting documents.`);
  }

  let cover: Cover | null = null;
  let takenFrom = 0;
  if (basis === 'OWN_LINES') {
    const lines = [
      ...input.summary.lines.filter((l) => l.status !== 'CANCELLED'),
      ...input.summary.sets.flatMap((s) => s.lines ?? []),
    ];
    takenFrom = lines.reduce((t, l) => t + (l.amount < 0 ? -l.amount : 0), 0);
  } else {
    const adding = input.summary.lines.filter((l) => l.status === 'DRAFT').reduce((t, l) => t + l.amount, 0);
    const approved = input.appropriations.filter((l) => l.status === 'APPROVED' && actKindOfLine(l) === o.kind);
    if (basis === 'ESTIMATED_REVENUE') {
      cover = coverOriginal({
        estimated: input.estimatedRevenue,
        approvedOriginal: approved.reduce((t, l) => t + l.amount, 0),
        adding,
      });
    } else {
      const byAct = new Map<string, number>();
      for (const l of approved) {
        const id = actId({ fiscalYear: l.fiscalYear, fundCode: l.fundCode, kind: o.kind, reference: l.authorityReference ?? '' });
        byAct.set(id, (byAct.get(id) ?? 0) + l.amount);
      }
      cover = coverEncoded({ kind: o.kind, actId: o.id, sources: input.sources, approvedByAct: byAct, adding });
    }
    if (!cover.ok) problems.push(coverShortfall(o.kind, o.reference, cover));
  }

  return { documented, basis, cover, takenFrom, ready: problems.length === 0, problems };
}
