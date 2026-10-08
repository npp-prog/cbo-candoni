/**
 * What an appropriation line must carry before it can become spending authority.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS FILE EXISTS BECAUSE OF
 * ---------------------------------------------------------------------------
 * `approveAppropriation` refused any line with no account code: "This
 * appropriation is missing its account code, so it cannot be approved."
 *
 * That was written when every appropriation was made to an OBJECT OF
 * EXPENDITURE, and it stayed true until patch 86, which added the second shape
 * the ordinance actually uses:
 *
 *   BY OBJECT. "Office Supplies Expenses, 150,000." The object code is also
 *   the Function/Programme/Project, because the ordinance named nothing else
 *   to appropriate to.
 *
 *   BY PROGRAMME. "Construction of Barangay Health Station, Payauan,
 *   2,000,000." The ordinance named a PROJECT and no object at all, and the
 *   object becomes known later, when the obligation is raised against it. The
 *   account code is EMPTY ON PURPOSE - budget control operates at the level
 *   the appropriation was made at, and filling in a guess would control the
 *   budget at a level the Sanggunian never set.
 *
 * The ordinance UPLOAD understood both and posts a by-programme line happily.
 * The approval path did not, so a by-programme line recorded on the screen
 * could be saved as a draft and then never approved - and the message told the
 * office to "record it again", which would produce another line it could not
 * approve either.
 *
 * ---------------------------------------------------------------------------
 * SO THE RULE IS WRITTEN ONCE, HERE
 * ---------------------------------------------------------------------------
 * An appropriation needs the LEVEL IT WAS MADE AT, which is the FPP code -
 * present in both shapes. The account code is required only where the
 * ordinance works by object, and there is exactly one case of that which is
 * not the office's choice: Personnel Services. Salaries and the rest are named
 * in the ordinance by their own object codes, the upload refuses a PS row
 * without one, and the recording form refuses it too; approval had no opinion,
 * which meant the three could disagree.
 *
 * Vendored into the engine, because the browser decides what to OFFER and the
 * engine decides what to ACCEPT. A screen that saves a draft the engine will
 * not approve is the shape of this whole defect, and one file is what stops it
 * happening again.
 *
 * It imports nothing, which is the condition of being vendored.
 */

export interface AppropriationShape {
  fundCode?: string | null;
  officeId?: string | null;
  /** The Function, Programme or Project the ordinance appropriated to. */
  fppCode?: string | null;
  /** The object of expenditure. EMPTY on a line appropriated by programme. */
  accountCode?: string | null;
  expenseClass?: string | null;
}

/**
 * What is missing from this line, in words an officer can act on.
 *
 * An empty list means the line is complete. Each entry names the thing that is
 * absent, so the caller can join them into one sentence rather than refusing
 * on the first and making the office discover the rest one save at a time.
 */
export function appropriationShapeProblems(line: AppropriationShape): string[] {
  const has = (v: string | null | undefined) => Boolean(v && String(v).trim());
  const problems: string[] = [];

  if (!has(line.fundCode)) problems.push('fund');
  if (!has(line.officeId)) problems.push('office');

  /*
   * EITHER IS ENOUGH, and this is the heart of it. A line appropriated by
   * object carries both - its object code is also its FPP. A line
   * appropriated by programme carries the programme and no object. A line
   * carrying neither was appropriated to nothing, and there is no budget line
   * for an obligation to be charged against.
   */
  if (!has(line.accountCode) && !has(line.fppCode)) {
    problems.push('account code or budget programme');
  }

  if (!has(line.expenseClass)) problems.push('expense classification');

  return problems;
}

/**
 * Whether Personnel Services may be appropriated this way.
 *
 * PS is appropriated by object of expenditure, always. Salaries, PERA and the
 * rest are named in the ordinance by their own object codes; there is no
 * "Personnel Services" project to appropriate to. The ordinance importer
 * refuses a PS row with no object code and the recording form refuses one
 * too - this is the same rule, so that approval refuses it as well instead of
 * letting in by one door what the other two turn away.
 */
export function personnelServicesNeedsObject(line: AppropriationShape): boolean {
  const cls = String(line.expenseClass ?? '').trim().toUpperCase();
  const code = String(line.accountCode ?? '').trim();
  return cls === 'PS' && !code;
}

/**
 * Everything wrong with the shape of this line, as one list.
 *
 * The caller refuses on the whole list rather than the first entry, because a
 * draft that is wrong in two ways is corrected once if it is told both.
 */
export function appropriationApprovalProblems(line: AppropriationShape): string[] {
  const problems = appropriationShapeProblems(line);

  if (personnelServicesNeedsObject(line)) {
    problems.push(
      'an object of expenditure - Personnel Services is appropriated by object, ' +
        'never by programme',
    );
  }

  return problems;
}

/**
 * How a budget line is named in a sentence.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT JUST `accountCode + accountName`
 * ---------------------------------------------------------------------------
 * It was, in four places, and on a line appropriated by programme it produced
 * sentences with a hole in them:
 *
 *     This makes 100,000.00 of spending authority available against  for
 *     Office of the Municipal Mayor.
 *
 *     This adjustment would drive the appropriation for   to 0.00.
 *
 * The office reads that as a bug in the figures, which is the worst place to
 * put a cosmetic fault: it is in the confirmation dialog for an act that
 * cannot be undone, and in the refusal that explains why a budget would go
 * negative. Somebody deciding whether to press Approve should not be wondering
 * whether the system knows what it is approving.
 *
 * So a line is named by whichever of the two it actually has, and a line with
 * neither says so rather than printing nothing.
 */
export function appropriationLineLabel(line: {
  accountCode?: string | null;
  accountName?: string | null;
  fppCode?: string | null;
  fppName?: string | null;
}): string {
  const join = (code?: string | null, name?: string | null) =>
    [String(code ?? '').trim(), String(name ?? '').trim()].filter(Boolean).join(' ');

  const byObject = join(line.accountCode, line.accountName);
  if (byObject) return byObject;

  const byProgramme = join(line.fppCode, line.fppName);
  if (byProgramme) return byProgramme;

  return 'this budget line';
}
