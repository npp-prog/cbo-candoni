/**
 * Sectors, and the four buckets the SRE reports them in.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS CODE AND NOT MASTER DATA
 * ---------------------------------------------------------------------------
 * The four buckets are statutory. DBM-DOF-DILG Joint Memorandum Circular
 * No. 2018-1, Annex A, gives the expenditure section of the SRE exactly four
 * lines under the General Fund - General Services, Economic Services, Social
 * Services, Debt Services - and an LGU does not get to add a fifth. A list
 * somebody can edit invites a fifth, and the SRE would then not foot to the
 * form BLGF expects.
 *
 * The sector NAMES on the left are the municipality's own, taken from the
 * FY2025 appropriation ordinance. Those can change, and when they do this file
 * changes with them - deliberately as a code change, reviewed, rather than as
 * a row somebody edits on a Tuesday.
 *
 * ---------------------------------------------------------------------------
 * THE TWO THAT ARE NOT SECTORS
 * ---------------------------------------------------------------------------
 * "20% Development Fund" and "LDRRMF" are funding SOURCES, not services. They
 * are a quarter of the municipality's budget between them - 49.9 million of
 * 212.1 in FY2025 - and a road built out of the 20% fund is economic services
 * however it was paid for.
 *
 * So a line in either must say which service it actually delivers. That is the
 * `serviceSector`, and without it the line cannot be placed in any of the four
 * buckets at all: it would have to go in a fifth, which does not exist.
 * ---------------------------------------------------------------------------
 */

/** The four expenditure buckets of the SRE, Annex A. */
export type SreBucket = 'GENERAL' | 'ECONOMIC' | 'SOCIAL' | 'DEBT';

export const SRE_BUCKET_LABELS: Record<SreBucket, string> = {
  GENERAL: 'General Services',
  ECONOMIC: 'Economic Services',
  SOCIAL: 'Social Services',
  DEBT: 'Debt Services',
};

export interface SectorDefinition {
  /** Exactly as the appropriation ordinance writes it. */
  name: string;
  /**
   * Where this sector's expenditure lands on the SRE. Null when the sector
   * names a funding source rather than a service, in which case the line must
   * carry a `serviceSector` of its own.
   */
  sreBucket: SreBucket | null;
  /** True for a funding source: the line must name the service it delivers. */
  fundingSource?: boolean;
}

export const SECTORS: SectorDefinition[] = [
  { name: 'General Public Services', sreBucket: 'GENERAL' },
  { name: 'Economic Services', sreBucket: 'ECONOMIC' },
  { name: 'Social Services and Social Welfare', sreBucket: 'SOCIAL' },
  { name: 'Health, Nutrition and Population Control', sreBucket: 'SOCIAL' },
  { name: 'Housing and Community Development', sreBucket: 'SOCIAL' },
  { name: 'Allocation for Senior Citizens and PWD', sreBucket: 'SOCIAL' },
  { name: 'Debt Services', sreBucket: 'DEBT' },
  // Funding sources. A project under either names its own service sector.
  { name: '20% Development Fund', sreBucket: null, fundingSource: true },
  { name: 'LDRRMF', sreBucket: null, fundingSource: true },
  // "Others" in the FY2025 ordinance is the statutory set-asides - GAD, LCPC,
  // the special purpose appropriations. Like the two above it is a source
  // rather than a service, and its projects deliver whichever service they
  // deliver.
  { name: 'Others', sreBucket: null, fundingSource: true },
];

const byName = new Map(SECTORS.map((s) => [normalise(s.name), s]));

function normalise(name: string): string {
  return name.trim().toUpperCase().replace(/\s+/g, ' ');
}

export function findSector(name: string | undefined | null): SectorDefinition | null {
  if (!name) return null;
  return byName.get(normalise(name)) ?? null;
}

export function isFundingSource(name: string | undefined | null): boolean {
  return findSector(name)?.fundingSource === true;
}

/**
 * Which of the four buckets a budget line belongs in.
 *
 * Returns null when the line cannot be placed - an unknown sector, or a
 * funding-source sector with no service sector named. Null is not a bucket and
 * must never be treated as one: a line CBO cannot classify has to be shown as
 * unclassified on the SRE, because silently dropping it makes the statement
 * foot to less than the municipality spent, and silently putting it in General
 * Services makes it foot correctly while saying something untrue.
 */
export function bucketFor(
  sector: string | undefined | null,
  serviceSector?: string | null,
): SreBucket | null {
  const found = findSector(sector);
  if (!found) return null;
  if (!found.fundingSource) return found.sreBucket;

  const service = findSector(serviceSector);
  // A service sector that is itself a funding source is not an answer.
  if (!service || service.fundingSource) return null;
  return service.sreBucket;
}

/** The sectors that may be named as a service - everything but the sources. */
export const SERVICE_SECTORS = SECTORS.filter((s) => !s.fundingSource);
