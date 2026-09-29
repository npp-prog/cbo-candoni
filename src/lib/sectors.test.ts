import { describe, it, expect } from 'vitest';
import {
  SECTORS,
  SERVICE_SECTORS,
  bucketFor,
  findSector,
  isFundingSource,
} from './sectors';

/**
 * The SRE has four expenditure buckets and the municipality's ordinance has
 * nine sectors. Everything here is about that gap, and about the quarter of
 * the budget that sits in a sector which is not a sector at all.
 */

describe('findSector', () => {
  it('finds a sector however it is spaced or cased', () => {
    expect(findSector('general public services')?.sreBucket).toBe('GENERAL');
    expect(findSector('  Health,  Nutrition and  Population Control ')?.sreBucket).toBe('SOCIAL');
  });

  it('returns null for something that is not a sector', () => {
    expect(findSector('Public Works')).toBeNull();
    expect(findSector('')).toBeNull();
    expect(findSector(undefined)).toBeNull();
  });
});

describe('bucketFor', () => {
  it('places an ordinary sector directly', () => {
    expect(bucketFor('Economic Services')).toBe('ECONOMIC');
    expect(bucketFor('Social Services and Social Welfare')).toBe('SOCIAL');
    expect(bucketFor('Allocation for Senior Citizens and PWD')).toBe('SOCIAL');
  });

  /**
   * The case the whole module exists for. A road built out of the 20%
   * Development Fund is economic services however it was paid for, and the
   * fund is not one of the four buckets.
   */
  it('places a funding-source line by the service it delivers', () => {
    expect(bucketFor('20% Development Fund', 'Economic Services')).toBe('ECONOMIC');
    expect(bucketFor('LDRRMF', 'Health, Nutrition and Population Control')).toBe('SOCIAL');
  });

  it('refuses to place a funding-source line that names no service', () => {
    expect(bucketFor('20% Development Fund')).toBeNull();
    expect(bucketFor('LDRRMF', '')).toBeNull();
    expect(bucketFor('Others', null)).toBeNull();
  });

  /**
   * "20% Development Fund, service sector: LDRRMF" answers nothing. Accepting
   * it would put a quarter of the budget in a bucket chosen by whichever
   * funding source happened to be typed second.
   */
  it('refuses a service sector that is itself a funding source', () => {
    expect(bucketFor('20% Development Fund', 'LDRRMF')).toBeNull();
    expect(bucketFor('LDRRMF', 'Others')).toBeNull();
  });

  it('returns null for an unknown sector rather than guessing', () => {
    expect(bucketFor('Public Works')).toBeNull();
  });
});

describe('the list itself', () => {
  it('knows the three funding sources', () => {
    expect(SECTORS.filter((s) => s.fundingSource).map((s) => s.name).sort()).toEqual([
      '20% Development Fund',
      'LDRRMF',
      'Others',
    ]);
    expect(isFundingSource('20% Development Fund')).toBe(true);
    expect(isFundingSource('Economic Services')).toBe(false);
  });

  /**
   * A funding source with a bucket of its own would silently stop needing a
   * service sector, and the rule would quietly cease to apply to a quarter of
   * the budget.
   */
  it('gives every ordinary sector a bucket and every funding source none', () => {
    for (const s of SECTORS) {
      if (s.fundingSource) expect(s.sreBucket, s.name).toBeNull();
      else expect(s.sreBucket, s.name).not.toBeNull();
    }
  });

  it('offers only real services as a service sector', () => {
    expect(SERVICE_SECTORS.every((s) => !s.fundingSource)).toBe(true);
    expect(SERVICE_SECTORS.length).toBe(SECTORS.length - 3);
  });

  it('covers every sector the FY2025 ordinance uses', () => {
    // The nine, exactly as the annex spells them.
    for (const name of [
      'General Public Services',
      'Economic Services',
      'Others',
      '20% Development Fund',
      'Health, Nutrition and Population Control',
      'Social Services and Social Welfare',
      'Housing and Community Development',
      'LDRRMF',
      'Allocation for Senior Citizens and PWD',
    ]) {
      expect(findSector(name), name).not.toBeNull();
    }
  });
});
