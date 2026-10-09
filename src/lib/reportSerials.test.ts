import { describe, expect, it } from 'vitest';
import { reportSerials } from './reportSerials';

describe('reportSerials (patch 148)', () => {
  it('works the range out from the lines of a draft', () => {
    expect(
      reportSerials({
        lines: [{ sourceNo: '123462' }, { sourceNo: '123460' }, { sourceNo: '123461' }],
      }),
    ).toEqual({ from: '123460', to: '123462' });
  });

  it('leaves a cancelled document out, as certification does', () => {
    expect(
      reportSerials({
        lines: [{ sourceNo: '2026-10-0003' }, { sourceNo: '2026-10-0004', excluded: true }],
      }),
    ).toEqual({ from: '2026-10-0003', to: '2026-10-0003' });
  });

  it('keeps the range the engine recorded', () => {
    expect(
      reportSerials({ serialFrom: '100', serialTo: '105', lines: [{ sourceNo: '999' }] }),
    ).toEqual({ from: '100', to: '105' });
  });

  it('has nothing to say for a report with no documents', () => {
    expect(reportSerials({ lines: [] })).toEqual({ from: null, to: null });
  });
});
