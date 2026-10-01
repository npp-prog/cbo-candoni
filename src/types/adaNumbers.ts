import type { ActorStamp, Id, IsoDate, IsoTimestamp } from './common';

/**
 * The ADA number series, and the explanations for the holes in it.
 *
 * ---------------------------------------------------------------------------
 * WHY A SERIES NEEDS EXPLAINING AT ALL
 * ---------------------------------------------------------------------------
 * An ADA number is an accountable serial in everything but name. The bank
 * receives them in order, and COA reads the register expecting an unbroken
 * run. A hole in that run is never nothing: it is either a payment made and
 * never reported, or a number the office passed over for a reason it has
 * forgotten.
 *
 * CFMS draws ADA numbers from a counter, so it cannot lose one by accident.
 * But offices do not work only inside one system: a batch is prepared and
 * abandoned, a number is promised to the bank for a transfer that falls
 * through, a serial is skipped when the register is written up by hand. Each
 * of those leaves a hole that is perfectly innocent and completely
 * unexplainable six months later.
 *
 * So this file records the fate of every number that is NOT an ordinary issue,
 * and the screen built on it puts the two side by side: the holes in the
 * series, and the explanations. A hole with no explanation is the only thing
 * anybody needs to look at.
 *
 * ---------------------------------------------------------------------------
 * WHY A RETIRED NUMBER IS NOT RETURNED TO THE POOL
 * ---------------------------------------------------------------------------
 * The obvious convenience - give the number back so the next ADA uses it -
 * is exactly wrong. The bank may already hold that number against an
 * instruction that was withdrawn. Reissuing it to a different payee is how a
 * municipality ends up with two ADAs the bank cannot tell apart.
 *
 * A retired number stays consumed for good. That is the point of retiring it
 * rather than deleting it.
 * ---------------------------------------------------------------------------
 */

export const ADA_NUMBER_STATES = ['RESERVED', 'USED', 'RETIRED', 'VOID_SKIPPED'] as const;
export type AdaNumberState = (typeof ADA_NUMBER_STATES)[number];

export const ADA_NUMBER_STATE_LABELS: Record<AdaNumberState, string> = {
  RESERVED: 'Reserved',
  USED: 'Used',
  RETIRED: 'Retired',
  VOID_SKIPPED: 'Skipped and voided',
};

export const ADA_NUMBER_STATE_HINTS: Record<AdaNumberState, string> = {
  RESERVED: 'Drawn ahead of the batch it is meant for. Nobody else can be given it.',
  USED: 'Consumed by an ADA. The register accounts for it in the ordinary way.',
  RETIRED:
    'Given up deliberately. The number stays consumed and can never be issued — the bank may already hold it against a withdrawn instruction.',
  VOID_SKIPPED:
    'Passed over and never issued. Recorded so the register can explain its own gap.',
};

export interface AdaNumberRecord {
  id: Id;
  fiscalYear: number;
  fundCode: string;

  /** The ADA number itself, as it is written. */
  adaNo: string;
  /** The paired report number, where the office reserves them together. */
  radaiNo?: string | null;
  /** The slot's date. A number used later must stay between its neighbours. */
  slotDate: IsoDate;

  state: AdaNumberState;
  note?: string | null;

  /** Set when a reservation is consumed. */
  usedByAdaId?: Id | null;
  usedAt?: IsoTimestamp | null;

  /** Required to retire a reservation or to void a skipped number. */
  reason?: string | null;

  createdBy: ActorStamp;
  createdAt: IsoTimestamp;
  closedBy?: ActorStamp;
}

/**
 * One hole in the issued series, and whether anything explains it.
 *
 * `explanation` is the record that accounts for the gap; when it is null the
 * office has a number it cannot account for, which is the only row on the
 * screen that matters.
 */
export interface AdaSeriesGap {
  /** The prefix the run belongs to, e.g. "100-26-09". */
  prefix: string;
  /** The missing number, rendered as it would have been written. */
  adaNo: string;
  sequence: number;
  explanation: AdaNumberRecord | null;
}
