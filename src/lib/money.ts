import type { Centavos } from '@/types/common';

/**
 * Money handling for CBO.
 *
 * Everything is centavos (integers). The only places pesos-as-decimals exist
 * are the user's keyboard and the printed page; both ends are handled here.
 */

/** Peso sign. Kept as a constant so encoding issues surface in one place. */
export const PESO = '₱';

/**
 * Parse user input into centavos.
 *
 * Accepts "1,234.56", "1234.5", "₱1,234.56", "(1,234.56)" for negative,
 * and bare "1234". Returns null when the input is not a valid amount, so the
 * caller can distinguish "empty" from "zero" - a distinction that matters on a
 * voucher line.
 */
export function parsePeso(input: string | number | null | undefined): Centavos | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return Math.round(input * 100);
  }

  let s = input.trim();
  if (s === '') return null;

  let negative = false;
  // Accounting-style parentheses for negatives.
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/[₱P]/gi, '').replace(/,/g, '').trim();
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1).trim();
  }
  if (s === '' || !/^\d*(\.\d{0,})?$/.test(s)) return null;

  const [whole, frac = ''] = s.split('.');
  const wholePart = whole === '' ? 0 : Number(whole);
  if (!Number.isSafeInteger(wholePart)) return null;

  // Take exactly two decimal places, rounding half-up on the third.
  const padded = (frac + '00').slice(0, 3);
  const centavoPart = Number(padded.slice(0, 2));
  const thirdDigit = Number(padded[2] ?? '0');
  let total = wholePart * 100 + centavoPart + (thirdDigit >= 5 ? 1 : 0);

  if (!Number.isSafeInteger(total)) return null;
  return negative ? -total : total;
}

/**
 * Format centavos as a Philippine peso string: ₱1,234,567.89.
 * Negative amounts use a leading minus by default; set `parens` for the
 * accounting convention used on statements.
 */
export function formatPeso(
  amount: Centavos | null | undefined,
  opts: { symbol?: boolean; parens?: boolean; dash?: boolean } = {},
): string {
  const { symbol = true, parens = false, dash = false } = opts;
  if (amount === null || amount === undefined) return dash ? '-' : '';
  if (dash && amount === 0) return '-';

  const negative = amount < 0;
  const abs = Math.abs(amount);
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  const wholeStr = whole.toLocaleString('en-PH');
  const body = `${symbol ? PESO : ''}${wholeStr}.${String(cents).padStart(2, '0')}`;

  if (!negative) return body;
  return parens ? `(${body})` : `-${body}`;
}

/** Format without the currency symbol, for table columns with a header unit. */
export function formatAmount(amount: Centavos | null | undefined, dash = true): string {
  return formatPeso(amount, { symbol: false, dash });
}

/** Convert centavos to a plain number of pesos, for charts and exports only. */
export function toPesos(amount: Centavos): number {
  return amount / 100;
}

/** Sum an array of centavos. Integer arithmetic throughout. */
export function sum(amounts: Centavos[]): Centavos {
  let total = 0;
  for (const a of amounts) total += a;
  return total;
}

/**
 * Apply a tax rate to a base, rounding half-up to the nearest centavo.
 *
 * BIR computations round to the centavo. `Math.round` in JavaScript rounds
 * half *away from zero* for positives but is unreliable for negatives
 * (Math.round(-0.5) === -0), so the sign is handled explicitly.
 */
export function applyRate(base: Centavos, rate: number): Centavos {
  if (!Number.isFinite(rate)) return 0;
  const raw = base * rate;
  const rounded = raw < 0 ? -Math.round(Math.abs(raw)) : Math.round(raw);
  return rounded;
}

/**
 * Net-of-VAT base used for expanded withholding tax on VAT-registered
 * suppliers: the VAT-inclusive gross divided by 1.12.
 */
export function netOfVat(gross: Centavos, vatRate = 0.12): Centavos {
  const raw = gross / (1 + vatRate);
  return Math.round(raw);
}

/** True when the value is a whole, finite number of centavos. */
export function isValidCentavos(value: unknown): value is Centavos {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * Amount in words, as required on the face of a disbursement voucher and a
 * check. Philippine convention: "ONE THOUSAND TWO HUNDRED THIRTY FOUR PESOS
 * AND 56/100 ONLY".
 */
export function amountInWords(amount: Centavos): string {
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const pesos = Math.floor(abs / 100);
  const cents = abs % 100;

  const words = pesos === 0 ? 'ZERO' : wholeNumberToWords(pesos);
  const centPart = `${String(cents).padStart(2, '0')}/100`;
  const prefix = negative ? 'MINUS ' : '';
  return `${prefix}${words} ${pesos === 1 ? 'PESO' : 'PESOS'} AND ${centPart} ONLY`;
}

const ONES = [
  '', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE',
  'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN',
  'SEVENTEEN', 'EIGHTEEN', 'NINETEEN',
];
const TENS = [
  '', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY',
];
const SCALES: Array<[number, string]> = [
  [1_000_000_000_000, 'TRILLION'],
  [1_000_000_000, 'BILLION'],
  [1_000_000, 'MILLION'],
  [1_000, 'THOUSAND'],
];

function wholeNumberToWords(n: number): string {
  if (n === 0) return 'ZERO';
  const parts: string[] = [];
  let rest = n;

  for (const [value, name] of SCALES) {
    if (rest >= value) {
      const count = Math.floor(rest / value);
      parts.push(`${wholeNumberToWords(count)} ${name}`);
      rest %= value;
    }
  }
  if (rest >= 100) {
    parts.push(`${ONES[Math.floor(rest / 100)]} HUNDRED`);
    rest %= 100;
  }
  if (rest >= 20) {
    const tens = TENS[Math.floor(rest / 10)];
    const ones = ONES[rest % 10];
    parts.push(ones ? `${tens} ${ones}` : tens);
  } else if (rest > 0) {
    parts.push(ONES[rest]);
  }
  return parts.join(' ').trim();
}
