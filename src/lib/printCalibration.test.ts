import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CHECK_FIELDS,
  CHECK_SHEET,
  OR_FIELDS,
  clearCalibration,
  defaultCalibration,
  exportCalibration,
  fieldStyle,
  importCalibration,
  loadCalibration,
  saveCalibration,
  splitWords,
} from './printCalibration';

/**
 * These tests are about the two ways a pre-printed form goes wrong: the ink
 * lands in the wrong place, or the calibration that put it in the right place
 * is lost. Everything below is one of those two.
 */

// The suite runs in a node environment, so `window` is supplied here. That is
// not only convenient: it is the same shape the guarded reads in the module
// have to cope with when a locked-down browser profile refuses storage.
function installStorage(impl?: Partial<Storage>) {
  const map = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
    ...impl,
  };
  (globalThis as unknown as { window: { localStorage: Storage } }).window = {
    localStorage: storage,
  };
}

beforeEach(() => installStorage());
afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('defaults', () => {
  it('carries every field of the form', () => {
    const cal = defaultCalibration(CHECK_FIELDS);
    expect(Object.keys(cal.fields).sort()).toEqual(CHECK_FIELDS.map((f) => f.key).sort());
  });

  it('starts with no nudge and no scaling', () => {
    const cal = defaultCalibration(OR_FIELDS, 9);
    expect(cal.offsetX).toBe(0);
    expect(cal.offsetY).toBe(0);
    expect(cal.fontScale).toBe(1);
    expect(cal.rowSpacing).toBe(9);
  });
});

describe('storage', () => {
  it('reads back what it wrote', () => {
    const cal = defaultCalibration(CHECK_FIELDS);
    cal.offsetY = 2.5;
    expect(saveCalibration('check', cal)).toBe(true);
    expect(loadCalibration('check', CHECK_FIELDS).offsetY).toBe(2.5);
  });

  it('falls back to the defaults when nothing is stored', () => {
    expect(loadCalibration('never-saved', CHECK_FIELDS).offsetX).toBe(0);
  });

  it('does not throw when storage refuses to be written', () => {
    installStorage({
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(saveCalibration('check', defaultCalibration(CHECK_FIELDS))).toBe(false);
  });

  it('does not throw when storage refuses to be read', () => {
    installStorage({
      getItem: () => {
        throw new Error('SecurityError');
      },
    });
    expect(() => loadCalibration('check', CHECK_FIELDS)).not.toThrow();
  });

  it('survives rubbish in storage', () => {
    window.localStorage.setItem('cbo.print.calibration.check', 'not json at all');
    expect(loadCalibration('check', CHECK_FIELDS).fontScale).toBe(1);
  });

  /**
   * The case that matters after a patch: a field added to the form since the
   * office calibrated must take its measured default rather than disappear
   * from the printout without anybody being told.
   */
  it('gives a newly added field its default instead of dropping it', () => {
    const partial = defaultCalibration(CHECK_FIELDS);
    delete partial.fields.memo;
    window.localStorage.setItem('cbo.print.calibration.check', JSON.stringify(partial));

    const loaded = loadCalibration('check', CHECK_FIELDS);
    expect(loaded.fields.memo).toBeDefined();
    expect(loaded.fields.memo.x).toBe(CHECK_FIELDS.find((f) => f.key === 'memo')!.x);
  });

  it('clears', () => {
    saveCalibration('check', { ...defaultCalibration(CHECK_FIELDS), offsetX: 9 });
    clearCalibration('check');
    expect(loadCalibration('check', CHECK_FIELDS).offsetX).toBe(0);
  });
});

describe('carrying a calibration to another workstation', () => {
  it('round-trips', () => {
    const cal = { ...defaultCalibration(CHECK_FIELDS), offsetX: -1.5, fontScale: 1.1 };
    const back = importCalibration(exportCalibration(cal), CHECK_FIELDS);
    expect(back?.offsetX).toBe(-1.5);
    expect(back?.fontScale).toBe(1.1);
  });

  it('returns null rather than throwing on rubbish', () => {
    expect(importCalibration('', CHECK_FIELDS)).toBeNull();
    expect(importCalibration('{"nope":1}', CHECK_FIELDS)).toBeNull();
    expect(importCalibration('[1,2,3]', CHECK_FIELDS)).toBeNull();
  });

  it('keeps a zero nudge as zero rather than reading it as missing', () => {
    const text = JSON.stringify({ ...defaultCalibration(CHECK_FIELDS), offsetX: 0, offsetY: 0 });
    expect(importCalibration(text, CHECK_FIELDS)?.offsetX).toBe(0);
  });
});

describe('fieldStyle', () => {
  const cal = defaultCalibration(CHECK_FIELDS);

  it('places a left field at its own millimetre', () => {
    const payee = CHECK_FIELDS.find((f) => f.key === 'payee')!;
    const style = fieldStyle(payee, cal, CHECK_SHEET);
    expect(style.left).toBe(`${payee.x}mm`);
    expect(style.top).toBe(`${payee.y}mm`);
  });

  /**
   * The peso column ends where the box ends, so a right-aligned field is
   * anchored from the right edge of the sheet. Anchoring it from the left
   * would move the figure every time the amount got longer, which is exactly
   * the case the box exists to prevent.
   */
  it('anchors a right-aligned field from the right edge of the sheet', () => {
    const figures = CHECK_FIELDS.find((f) => f.key === 'amountFigures')!;
    const style = fieldStyle(figures, cal, CHECK_SHEET);
    expect(style.right).toBe(`${CHECK_SHEET.width - figures.x}mm`);
    expect(style.left).toBeUndefined();
  });

  it('applies the whole-sheet nudge to every field', () => {
    const nudged = { ...cal, offsetX: 1, offsetY: -2 };
    const payee = CHECK_FIELDS.find((f) => f.key === 'payee')!;
    const style = fieldStyle(payee, nudged, CHECK_SHEET);
    expect(style.left).toBe(`${payee.x + 1}mm`);
    expect(style.top).toBe(`${payee.y - 2}mm`);
  });

  it('spaces repeating rows by the row spacing', () => {
    const orCal = defaultCalibration(OR_FIELDS, 9);
    const line = OR_FIELDS.find((f) => f.key === 'lineDescription')!;
    expect(fieldStyle(line, orCal, { width: 105, height: 215 }, 0).top).toBe(`${line.y}mm`);
    expect(fieldStyle(line, orCal, { width: 105, height: 215 }, 3).top).toBe(`${line.y + 27}mm`);
  });

  it('scales the type without moving anything', () => {
    const scaled = { ...cal, fontScale: 1.2 };
    const payee = CHECK_FIELDS.find((f) => f.key === 'payee')!;
    const style = fieldStyle(payee, scaled, CHECK_SHEET);
    expect(style.fontSize).toBe(`${(payee.size * 1.2).toFixed(2)}pt`);
    expect(style.left).toBe(`${payee.x}mm`);
  });

  /**
   * Two forms are on screen at once whenever a receipt preview sits behind a
   * check preview. Each must be measured against its own paper.
   */
  it('measures the right anchor against the sheet it is given', () => {
    const figures = CHECK_FIELDS.find((f) => f.key === 'amountFigures')!;
    const onCheck = fieldStyle(figures, cal, CHECK_SHEET);
    const onReceipt = fieldStyle(figures, cal, { width: 105, height: 215 });
    expect(onCheck.right).not.toBe(onReceipt.right);
  });
});

describe('splitWords', () => {
  it('leaves a short amount on one line', () => {
    expect(splitWords('ONE HUNDRED PESOS AND 00/100 ONLY')).toEqual([
      'ONE HUNDRED PESOS AND 00/100 ONLY',
      '',
    ]);
  });

  it('breaks on a space, never mid-word', () => {
    const words =
      'ONE MILLION TWO HUNDRED THIRTY FOUR THOUSAND FIVE HUNDRED SIXTY SEVEN PESOS AND 89/100 ONLY';
    const [a, b] = splitWords(words, 62);
    expect(a.length).toBeLessThanOrEqual(62);
    expect(a.endsWith(' ')).toBe(false);
    expect(b.startsWith(' ')).toBe(false);
    expect(`${a} ${b}`).toBe(words);
  });

  /**
   * A hard break must not eat a character. An amount in words that silently
   * loses a letter is worse than one that wraps awkwardly, and it would only
   * ever happen on the long amounts - the ones worth the most.
   */
  it('still splits when there is no space to break on, and loses nothing', () => {
    const [a, b] = splitWords('X'.repeat(80), 62);
    expect(a).toHaveLength(62);
    expect(b).toHaveLength(18);
    expect(a + b).toBe('X'.repeat(80));
  });
});
