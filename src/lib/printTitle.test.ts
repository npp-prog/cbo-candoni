import { describe, expect, it } from 'vitest';
import { printFileName } from './printTitle';

describe('printFileName (patch 156)', () => {
  it('is the document type and its number', () => {
    expect(printFileName('Report of Checks Issued', '2026-10-0001')).toBe(
      'Report of Checks Issued_2026-10-0001',
    );
  });
  it('drops characters a file name cannot hold', () => {
    expect(printFileName('Journal Voucher', '100/2026:10')).toBe('Journal Voucher_100-2026-10');
  });
  it('is the type alone when there is no number', () => {
    expect(printFileName('Trial Balance', '')).toBe('Trial Balance');
  });
});
