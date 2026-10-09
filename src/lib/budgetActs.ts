/**
 * The acts that make appropriations, and what finances each. Patch 123.
 *
 * Shared with the engine (scripts/sync-rules.mjs): the screen says whether an
 * act may be approved, and the engine decides. Two copies of the coverage rule
 * would be two answers to "is this supplemental budget funded?".
 *
 * ---------------------------------------------------------------------------
 * FIVE ACTS
 * ---------------------------------------------------------------------------
 *   ORIGINAL       ordinance   the annual budget
 *   SUPPLEMENTAL   ordinance   additional authority during the year
 *   REALIGNMENT    ordinance   authority moved across expense classes (s.321)
 *   AUGMENTATION   LCE order   savings moved within one class (s.336)
 *   CONTINUING     certified   last year's authority carried into this one
 *
 * Every one is a document of its own, with the signed copy attached, and none
 * becomes authority without both the copy and its sources. Neil, 09 Oct 2026.
 *
 * ---------------------------------------------------------------------------
 * WHAT FINANCES EACH
 * ---------------------------------------------------------------------------
 *   ORIGINAL       the Estimated Revenue - the Sources of Financing schedule
 *                  (LBP Form No. 1). Original appropriations may not exceed it.
 *   SUPPLEMENTAL   LBP Form No. 8, 1.0 New Revenue Sources, 2.0 Actual
 *                  Collection in Excess of the Estimated Income and 3.0
 *                  Savings - encoded.
 *   REALIGNMENT    LBP Form No. 8, 4.0 Realignment - the lines it takes from.
 *   AUGMENTATION   its own savings - the lines it takes from. NOT on LBP
 *                  Form No. 8: under the omnibus authority the Sanggunian
 *                  gives the Local Chief Executive, an augmentation is not
 *                  part of a supplemental budget (Neil, patch 126). Savings
 *                  that DO finance a supplemental budget are encoded as 3.0.
 *   CONTINUING     the Continuing sources - encoded.
 *
 * A realignment and an augmentation finance themselves: the set must come to
 * zero, so what it gives is exactly what it takes, and the engine has
 * enforced that since patch 112. The other three need a figure from outside
 * the act, and that is what this file checks.
 */

export type ActKind = 'ORIGINAL' | 'SUPPLEMENTAL' | 'REALIGNMENT' | 'AUGMENTATION' | 'CONTINUING';

export const ACT_KINDS: Array<{
  value: ActKind;
  label: string;
  /** What the document is, for the record form and the heading. */
  document: string;
  /** What its number is called. */
  numberLabel: string;
  placeholder: string;
  hint: string;
}> = [
  {
    value: 'ORIGINAL',
    label: 'Original budget',
    document: 'Appropriation Ordinance',
    numberLabel: 'Ordinance number',
    placeholder: 'Ord. No. 2026-01',
    hint: 'The annual budget. Financed by the Estimated Revenue on the Sources of Financing schedule.',
  },
  {
    value: 'SUPPLEMENTAL',
    label: 'Supplemental budget',
    document: 'Supplemental Appropriation Ordinance',
    numberLabel: 'Ordinance number',
    placeholder: 'Ord. No. 2026-07',
    hint: 'Additional authority during the year. Financed by new revenue, collections in excess of the estimate, or savings (LBP Form No. 8, 1.0 to 3.0).',
  },
  {
    value: 'REALIGNMENT',
    label: 'Realignment',
    document: 'Realignment Ordinance',
    numberLabel: 'Ordinance number',
    placeholder: 'Ord. No. 2026-14',
    hint: 'Authority moved across expense classes by the Sanggunian (s.321). What it takes from is its source (LBP Form No. 8, 4.0).',
  },
  {
    value: 'AUGMENTATION',
    label: 'Augmentation',
    document: 'Augmentation Order',
    numberLabel: 'Office or executive order number',
    placeholder: 'Office Order No. 2026-03',
    hint: 'Savings moved within one expense class by the Local Chief Executive under the authority the Sanggunian gave (s.336). The savings it takes from are its source; it is not part of a supplemental budget.',
  },
  {
    value: 'CONTINUING',
    label: 'Continuing appropriation',
    document: 'Certification of Continuing Appropriations',
    numberLabel: 'Reference',
    placeholder: 'Continuing FY 2025',
    hint: "Last year's authority carried into this one. Financed by the Continuing sources.",
  },
];

export const actKindLabel = (k: string): string => ACT_KINDS.find((a) => a.value === k)?.label ?? k;

/** The reference made safe for a document id, as the engine makes it. */
export function slugReference(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** The id an act is stored under - so the same one cannot be recorded twice. */
export function actId(o: {
  fiscalYear: number;
  fundCode: string;
  kind: string;
  reference: string;
}): string {
  return `${o.fiscalYear}__${o.fundCode}__${o.kind}__${slugReference(o.reference)}`;
}

/**
 * The act an appropriation line was made by. An augmentation's lines are kind
 * REALIGNMENT with instrument AUGMENTATION; SUPPLEMENTAL as an instrument is
 * the realignment's old name. ADJUSTMENT and TRANSFER are corrections, not
 * acts, and are not gated.
 */
export function actKindOfLine(line: { kind?: string; instrument?: string | null }): ActKind | null {
  switch (line.kind) {
    case 'ORIGINAL':
    case 'SUPPLEMENTAL':
    case 'CONTINUING':
      return line.kind;
    case 'REALIGNMENT':
      return line.instrument === 'AUGMENTATION' ? 'AUGMENTATION' : 'REALIGNMENT';
    default:
      return null;
  }
}

/** The act a prepared set will be posted under. */
export const actKindOfInstrument = (instrument: string | null | undefined): ActKind =>
  instrument === 'AUGMENTATION' ? 'AUGMENTATION' : 'REALIGNMENT';

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** The sources that are ENCODED. A realignment's (4.0) are read from the act itself. */
export type SourceSection = 'NEW_REVENUE' | 'EXCESS_COLLECTION' | 'SAVINGS' | 'CONTINUING';

export const SOURCE_SECTIONS: Array<{ value: SourceSection; label: string; finances: ActKind }> = [
  { value: 'NEW_REVENUE', label: '1.0 New Revenue Sources', finances: 'SUPPLEMENTAL' },
  {
    value: 'EXCESS_COLLECTION',
    label: '2.0 Actual Collection in Excess of the Estimated Income',
    finances: 'SUPPLEMENTAL',
  },
  { value: 'SAVINGS', label: '3.0 Savings', finances: 'SUPPLEMENTAL' },
  { value: 'CONTINUING', label: 'Continuing', finances: 'CONTINUING' },
];

export const sectionLabel = (s: string): string =>
  SOURCE_SECTIONS.find((x) => x.value === s)?.label ?? s;

/** The encoded sections that finance an act of this kind; empty when it finances itself or is financed by the schedule. */
export const sectionsFinancing = (kind: ActKind): SourceSection[] =>
  SOURCE_SECTIONS.filter((s) => s.finances === kind).map((s) => s.value);

export type FundingBasis = 'ESTIMATED_REVENUE' | 'ENCODED' | 'OWN_LINES';

export const fundingBasis = (kind: ActKind): FundingBasis =>
  kind === 'ORIGINAL'
    ? 'ESTIMATED_REVENUE'
    : kind === 'SUPPLEMENTAL' || kind === 'CONTINUING'
      ? 'ENCODED'
      : 'OWN_LINES';

export interface SourceEntry {
  section: string;
  amount: number;
  /** The act this source was encoded in. Absent: encoded on the Sources tab, open to any act it can finance. */
  actId?: string | null;
}

export interface Cover {
  ok: boolean;
  /** What the act will total once this approval goes through. */
  needed: number;
  /** What is there to finance it. */
  available: number;
  /** Encoded in this act. */
  own: number;
  /** Left of the sources encoded on the Sources tab, after the acts already approved drew on them. */
  open: number;
}

/**
 * Whether a SUPPLEMENTAL or CONTINUING act is financed.
 *
 * Sources encoded IN an act finance that act. Sources encoded on the Sources
 * tab are open: each approved act draws on them for whatever its own sources
 * did not cover, and what is left is open to the next. So a certification of
 * excess collection entered once on the Sources tab can finance two
 * supplemental budgets in turn, and a source entered inside an ordinance is
 * never taken by a different one.
 *
 * @param approvedByAct   the approved total of every act of this kind, this one included
 * @param adding          what this approval adds to this act
 */
export function coverEncoded(input: {
  kind: ActKind;
  actId: string;
  sources: SourceEntry[];
  approvedByAct: Map<string, number>;
  adding: number;
}): Cover {
  const sections = new Set<string>(sectionsFinancing(input.kind));
  const mine = input.sources.filter((s) => sections.has(s.section));
  const linked = new Map<string, number>();
  let pool = 0;
  for (const s of mine) {
    if (s.actId) linked.set(s.actId, (linked.get(s.actId) ?? 0) + s.amount);
    else pool += s.amount;
  }
  let drawnByOthers = 0;
  for (const [id, total] of input.approvedByAct) {
    if (id === input.actId) continue;
    drawnByOthers += Math.max(0, total - (linked.get(id) ?? 0));
  }
  const own = linked.get(input.actId) ?? 0;
  const open = Math.max(0, pool - drawnByOthers);
  const needed = (input.approvedByAct.get(input.actId) ?? 0) + input.adding;
  return { ok: needed <= own + open, needed, available: own + open, own, open };
}

/**
 * Whether the ORIGINAL budget is financed: every original appropriation of the
 * year and fund, approved and being approved, within the estimated revenue.
 */
export function coverOriginal(input: {
  estimated: number;
  approvedOriginal: number;
  adding: number;
}): Cover {
  const needed = input.approvedOriginal + input.adding;
  return {
    ok: input.estimated > 0 && needed <= input.estimated,
    needed,
    available: input.estimated,
    own: 0,
    open: input.estimated,
  };
}

/**
 * The approved acts a change of sources would leave unfinanced. The engine
 * refuses a source deleted or reduced from under an act already approved.
 */
export function actsLeftUnfunded(input: {
  kind: ActKind;
  sources: SourceEntry[];
  approvedByAct: Map<string, number>;
}): string[] {
  const out: string[] = [];
  for (const id of input.approvedByAct.keys()) {
    const c = coverEncoded({
      kind: input.kind,
      actId: id,
      sources: input.sources,
      approvedByAct: input.approvedByAct,
      adding: 0,
    });
    if (!c.ok) out.push(id);
  }
  return out;
}

const peso = (c: number) =>
  (c / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The sentence the screen and the engine both say when an act is short. */
export function coverShortfall(kind: ActKind, reference: string, c: Cover): string {
  if (kind === 'ORIGINAL') {
    return c.available <= 0
      ? `${reference} cannot be approved: no Estimated Revenue is recorded for the year. Record it on Budget > Sources of Financing first - the original budget may not exceed it.`
      : `${reference} cannot be approved: the original budget would come to ${peso(c.needed)} against Estimated Revenue of ${peso(c.available)}. Appropriations may not exceed the estimated income.`;
  }
  const where =
    kind === 'SUPPLEMENTAL'
      ? '1.0 New Revenue Sources, 2.0 Excess Collection or 3.0 Savings'
      : 'Continuing sources';
  return (
    `${reference} cannot be approved: it would come to ${peso(c.needed)} and its sources come to ${peso(c.available)}` +
    ` (${peso(c.own)} encoded in it, ${peso(c.open)} open on the Sources tab). Encode ${peso(c.needed - c.available)} more in ${where}, in the act or on the Sources tab.`
  );
}
