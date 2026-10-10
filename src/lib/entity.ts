/**
 * Who the municipality is, as its printed forms say so.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT THREE LINES IN A COMPONENT
 * ---------------------------------------------------------------------------
 * It was. `formParts.tsx` printed one heading, `ReportShell.tsx` printed a
 * different one, and both were written out in code:
 *
 *     Republic of the Philippines
 *     Province of Negros Occidental
 *     Municipality of Candoni
 *
 * The municipality's own COA forms - the ones in Appendix_Forms.xlsx, already
 * carrying Candoni's name - do not say that. They say:
 *
 *     Republic of the Philippines
 *     MUNICIPAL GOVERNMENT OF CANDONI
 *     Municipal Building, Rizal St., Candoni, Negros Occidental, 6110
 *
 * No province line of its own, and the street address instead of an office.
 * Every form CFMS printed had the wrong heading on it, in two different wrong
 * ways, and neither could be corrected without a patch.
 *
 * ---------------------------------------------------------------------------
 * AND WHY THE OFFICIALS ARE HERE TOO
 * ---------------------------------------------------------------------------
 * The prescribed forms print the office holder's NAME over the signature line -
 * the Local Treasurer certifies the Report of Checks Issued, the Mayor and the
 * Treasurer together authorise an ADA. Those names change with an election, and
 * a name that needs a patch to change is a name that will be wrong for months.
 *
 * They come from ADMINISTRATION > SETTINGS, with the values from the
 * municipality's own forms as the fallback - so a form prints correctly on the
 * day this patch lands, and is editable from then on.
 */

/** What a signature line needs: a name over a designation. */
export interface Official {
  name: string;
  position: string;
}

export interface EntityDetails {
  /** The three heading lines, in order, exactly as the forms print them. */
  headingLines: string[];
  localTreasurer: Official;
  municipalMayor: Official;
  municipalAccountant: Official;
  /** Whoever prepares the forms in Accounting. */
  bookkeeper: Official;
  /** Patch 163: signs FDP Form 6 (Trust Fund Utilization). */
  budgetOfficer: Official;
  /** Patch 164: one of the Local Finance Committee on FDP Form 6b. */
  planningCoordinator: Official;
  /** Patch 162: the municipality's TIN and ZIP code - Part II of BIR Form 2307. */
  tin?: string;
  zipCode?: string;
}

/*
 * The municipality's own values, taken from the forms it already uses.
 *
 * A fallback, not a default to be relied on: Settings overrides every one of
 * them. They are here so that nothing prints blank before somebody has been
 * into Settings, because a COA form with no entity name on it is not a form.
 */
const FALLBACK: EntityDetails = {
  headingLines: [
    'Republic of the Philippines',
    'MUNICIPAL GOVERNMENT OF CANDONI',
    'Municipal Building, Rizal St., Candoni, Negros Occidental, 6110',
  ],
  localTreasurer: { name: '', position: 'Local Treasurer' },
  municipalMayor: { name: '', position: 'Municipal Mayor' },
  municipalAccountant: { name: '', position: 'Municipal Accountant' },
  bookkeeper: { name: '', position: 'Bookkeeper' },
  budgetOfficer: { name: '', position: 'Municipal Budget Officer' },
  planningCoordinator: { name: '', position: 'Municipal Planning and Development Coordinator' },
};

/**
 * Note what the fallback does NOT carry: anybody's name.
 *
 * The entity's name and address are facts about the municipality and are the
 * same on every form. Who holds an office is not - it changes with an election
 * and with a reassignment, and a name written into the source code would print
 * on a certification long after that person had left. Blank, and filled in from
 * Settings, is the honest state: a signature line is signed by hand anyway, and
 * an empty printed name says "nobody has told CFMS" rather than naming the
 * wrong person.
 */
export interface EntitySettings {
  entityName?: string;
  address?: string;
  tin?: string;
  zipCode?: string;
  officials?: Partial<Record<keyof Omit<EntityDetails, 'headingLines'>, Official>>;
}

/**
 * The settings record merged over the fallback.
 *
 * Pure, and separate from the hook, so the merge can be tested: a blank or
 * whitespace-only entity name has to fall back rather than print an empty line
 * where the municipality's name goes, and that is exactly the sort of thing a
 * half-filled Settings record produces.
 */
export function entityFrom(data: EntitySettings | null | undefined): EntityDetails {
  if (!data) return FALLBACK;

  const entityName = data.entityName?.trim();
  const address = data.address?.trim();

  return {
    headingLines: [
      FALLBACK.headingLines[0],
      entityName || FALLBACK.headingLines[1],
      address || FALLBACK.headingLines[2],
    ],
    localTreasurer: data.officials?.localTreasurer ?? FALLBACK.localTreasurer,
    municipalMayor: data.officials?.municipalMayor ?? FALLBACK.municipalMayor,
    municipalAccountant: data.officials?.municipalAccountant ?? FALLBACK.municipalAccountant,
    bookkeeper: data.officials?.bookkeeper ?? FALLBACK.bookkeeper,
    budgetOfficer: data.officials?.budgetOfficer ?? FALLBACK.budgetOfficer,
    planningCoordinator: data.officials?.planningCoordinator ?? FALLBACK.planningCoordinator,
    tin: data.tin?.trim() || undefined,
    zipCode: data.zipCode?.trim() || undefined,
  };
}
