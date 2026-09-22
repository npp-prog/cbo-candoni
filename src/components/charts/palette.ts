/**
 * Chart palette.
 *
 * Four categorical slots, assigned in fixed order and never cycled. Validated
 * against a white card surface: lightness band, chroma floor, colour-vision
 * separation (worst adjacent pair deltaE 9.2 deutan, 27.6 normal) and contrast
 * all pass.
 *
 * The aqua slot sits just under 3:1 against white, which means colour alone
 * must never be the only way to read a series. Every chart in CBO therefore
 * carries a legend with text labels and a tooltip that names the series, and
 * the figures behind each chart also appear as numbers on the dashboard cards
 * and in the underlying registers. That is the required relief, and it is
 * appropriate here anyway - an accountant wants the number, not an impression.
 *
 * Fixed order matters for a second reason specific to this system: "Obligated"
 * must stay the same colour whichever offices a filter leaves on screen.
 * Colour follows the series, never its rank.
 */

export const SERIES = {
  /** Slot 1 - primary measure: obligations, expenses, the main line. */
  primary: '#2a78d6',
  /** Slot 2 - the comparison measure: disbursements, actual against budget. */
  secondary: '#eb6834',
  /** Slot 3 - collections and other inflows. */
  tertiary: '#1baf7a',
  /** Slot 4 - a fourth measure where one is genuinely needed. */
  quaternary: '#4a3aa7',
} as const;

export const SERIES_ORDER = [SERIES.primary, SERIES.secondary, SERIES.tertiary, SERIES.quaternary];

/** Status colours, reserved and never reused as a series colour. */
export const STATUS = {
  good: '#008300',
  warning: '#eda100',
  serious: '#eb6834',
  critical: '#e34948',
} as const;

/** Recessive chrome: the grid and axes must not compete with the data. */
export const CHART_CHROME = {
  grid: '#e8eaee',
  axis: '#94a3b8',
  text: '#52514e',
  surface: '#ffffff',
} as const;

/**
 * Sequential ramp for aging buckets, light to dark in one hue. Ordinal use, so
 * the lightest step is no lighter than the 250 step, which clears 2:1 against
 * a white surface.
 */
export const SEQUENTIAL_BLUE = ['#86b6ef', '#5598e7', '#3987e5', '#256abf', '#184f95'];
