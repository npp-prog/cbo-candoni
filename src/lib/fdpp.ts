import type { CashFlowStatement } from '@/pages/reports/cashFlows';
import type { Appropriation, BudgetBalance, TrustFundSource, TrustProgram } from '@/types/budget';
import { COMMITTED, lineKey } from './budgetPeriods';

/**
 * Patch 163 - the Full Disclosure Policy Portal (FDPP) reports, worked out of
 * the books. Five of them, each a quarterly form the BLGF portal takes:
 *
 *   Form 6   Trust Fund Utilization - the Trust Fund programmes funded by a
 *            national agency or another LGU (not the municipality's own).
 *   Form 8   LDRRMF Utilization - the LDRRMF lines of the General Fund budget
 *            and the LDRRMF carried in the Special Trust Fund.
 *   Form 9   Statement of Cash Flows - the General Fund, the SEF and the Trust
 *            Fund together, on the BLGF Annex 2 lines.
 *   Form 11  SEF Utilization - SEF receipts, less SEF disbursements by
 *            expense class and object.
 *   Form 12  Unliquidated Cash Advances - every fund, by debtor, aged.
 *
 * Nothing is typed into a report. What the office states (a programme's
 * source, location, physical completion) is stated once, on the programme.
 */

export const FDP_PLACE = {
  // Patch 164: Negros Occidental is in the Negros Island Region now.
  region: 'NEGROS ISLAND REGION',
  province: 'NEGROS OCCIDENTAL',
  municipality: 'CANDONI',
};

export const FDP_CERTIFICATION =
  'We hereby certify that we have reviewed the contents and hereby attest to the veracity and ' +
  'correctness of the data or information contained in this document.';

export type Quarter = 1 | 2 | 3 | 4;

export function quarterRange(year: number, q: Quarter) {
  const firstPeriod = (q - 1) * 3 + 1;
  const lastPeriod = q * 3;
  const lastDay = new Date(Date.UTC(year, lastPeriod, 0)).getUTCDate();
  const mm = (n: number) => String(n).padStart(2, '0');
  return {
    from: `${year}-${mm(firstPeriod)}-01`,
    to: `${year}-${mm(lastPeriod)}-${mm(lastDay)}`,
    firstPeriod,
    lastPeriod,
  };
}

/** The quarter a date is in. */
export function quarterOfDate(date: string): Quarter {
  return (Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1) as Quarter;
}

// ===========================================================================
// Form 6 - Trust Fund Utilization
// ===========================================================================

const OWN_HINT =
  /\b(BAC|FIESTA|TOURISM|SK\b|SANGGUNIANG KABATAAN|PHILHEALTH|HOSPITAL CHARGES|PROF(ESSIONAL)? FEE)/i;
const LDRRMF_HINT = /DRRM|QUICK RESPONSE|\bQRF\b|CALAMITY/i;

/**
 * Where a programme's money came from: as the Accountant set it on the
 * programme, or - while it is not set - read from its name and source, and
 * flagged as read so the report says so.
 */
export function trustSourceOf(
  p: Pick<TrustProgram, 'fundSource' | 'programName' | 'sourceAgency'>,
): {
  source: TrustFundSource;
  inferred: boolean;
} {
  if (p.fundSource) return { source: p.fundSource, inferred: false };
  const text = `${p.programName} ${p.sourceAgency}`;
  if (LDRRMF_HINT.test(text)) return { source: 'LDRRMF', inferred: true };
  if (OWN_HINT.test(text) || /MUNICIPAL(ITY)? OF CANDONI|LGU[- ]CANDONI/i.test(p.sourceAgency))
    return { source: 'OWN', inferred: true };
  return { source: 'NATIONAL', inferred: true };
}

export interface Form6Row {
  id: string;
  program: string;
  location: string;
  totalCost: number;
  dateStarted: string;
  targetCompletion: string;
  percentComplete: number;
  costIncurred: number;
  extensions: string;
  remarks: string;
  inferred: boolean;
}

export function buildForm6(
  programs: TrustProgram[],
  year: number,
  /** Patch 164: the programme's figures as at the quarter's end (trustFiguresAsOf). */
  asOf?: Map<string, TrustAsOf>,
): Form6Row[] {
  return programs
    .filter((p) => {
      const { source } = trustSourceOf(p);
      if (source !== 'NATIONAL' && source !== 'LOCAL') return false;
      if (p.startYear && p.startYear > year) return false;
      // A closed programme is reported in the year it was closed, then drops off.
      if (p.status === 'CLOSED') return String(p.updatedAt ?? '').slice(0, 4) === String(year);
      return true;
    })
    .map((p) => {
      const utilised = asOf?.get(p.id)?.utilised ?? p.utilised ?? 0;
      const pct =
        p.percentComplete ??
        (p.programmed > 0 ? Math.round((utilised / p.programmed) * 10000) / 100 : 0);
      const remarks =
        p.statusRemarks ||
        (utilised <= 0 ? 'Unutilized' : utilised >= p.programmed ? 'Fully utilized' : 'On-going');
      return {
        id: p.id,
        program: `${p.programCode} - ${p.programName}`,
        location: p.location || FDP_PLACE.municipality,
        totalCost: p.programmed,
        dateStarted: p.dateStarted ?? '',
        targetCompletion: p.targetCompletion ?? '',
        percentComplete: pct,
        costIncurred: utilised,
        extensions: p.extensions ? String(p.extensions) : '',
        remarks,
        inferred: trustSourceOf(p).inferred,
      };
    })
    .sort((a, b) => a.program.localeCompare(b.program, undefined, { numeric: true }));
}

// ===========================================================================
// Form 6b - Local Government Support Fund (patch 164)
// ===========================================================================

export interface Form6bRow {
  id: string;
  fundSource: string;
  nadaiDate: string;
  projectType: string;
  title: string;
  location: string;
  mechanism: string;
  beneficiaries: string;
  received: number;
  obligation: number;
  disbursement: number;
  estimatedCompletion: string;
  remarks: string;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "2026-03" -> "March 2026" */
export function monthYear(ym: string | null | undefined): string {
  if (!ym || !/^\d{4}-\d{2}/.test(ym)) return '';
  return `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1] ?? ''} ${ym.slice(0, 4)}`;
}

/**
 * The Trust Fund programmes tagged LGSF. Received is what the NADAI
 * released (the programme's stated receipt); Obligation and Disbursement are
 * as at the quarter's end.
 */
export function buildForm6b(
  programs: TrustProgram[],
  year: number,
  asOf?: Map<string, TrustAsOf>,
): Form6bRow[] {
  return programs
    .filter((p) => {
      if (!p.lgsf) return false;
      if (p.startYear && p.startYear > year) return false;
      if (p.nadaiDate && Number(p.nadaiDate.slice(0, 4)) > year) return false;
      if (p.status === 'CLOSED') return String(p.updatedAt ?? '').slice(0, 4) === String(year);
      return true;
    })
    .map((p) => {
      const f = asOf?.get(p.id);
      const obligation = f?.utilised ?? p.utilised ?? 0;
      const disbursement = f?.disbursed ?? p.disbursed ?? 0;
      return {
        id: p.id,
        fundSource: p.lgsfFundSource || p.sourceAgency,
        nadaiDate: p.nadaiDate ?? '',
        projectType: p.projectType ?? '',
        title: `${p.programCode} - ${p.programName}`,
        location: p.location || FDP_PLACE.municipality,
        mechanism: p.mechanism ?? '',
        beneficiaries: p.beneficiaries ? p.beneficiaries.toLocaleString('en-PH') : '',
        received: p.received || p.programmed,
        obligation,
        disbursement,
        estimatedCompletion: monthYear(p.estimatedCompletion),
        remarks:
          p.statusRemarks ||
          (obligation <= 0
            ? 'Not yet started'
            : disbursement >= obligation
              ? 'Completed'
              : 'On-going'),
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
}

// ===========================================================================
// Patch 164 - a Trust Fund programme as it stood at the end of the quarter
// ===========================================================================

export interface TrustAsOf {
  utilised: number;
  disbursed: number;
}

export interface ObligationLike {
  id: string;
  obrDate: string;
  status: string;
  totalAmount?: number;
  lines: Array<{
    amount: number;
    trustProgramId?: string | null;
    officeId?: string;
    officeName?: string;
    fppCode?: string;
    fppName?: string;
    appropriatedAccountCode?: string;
    accountName?: string;
    expenseClass?: string;
  }>;
}

export interface VoucherLike {
  dvDate: string;
  status: string;
  obligationId?: string | null;
  grossAmount: number;
}

/**
 * A programme's utilised and disbursed figures are running totals, kept by
 * the server as FURS are certified and vouchers paid. As they stood at
 * `asOf`, they are the running totals less whatever came AFTER: the FURS
 * certified later, and the vouchers paid later (a voucher's amount spread
 * over its FURS's programmes in proportion to the lines).
 *
 * `obligations` and `vouchers` are the Trust Fund's of the report's year and
 * the year after - everything that can be dated after the quarter's end.
 */
export function trustFiguresAsOf(
  programs: TrustProgram[],
  obligations: ObligationLike[],
  vouchers: VoucherLike[],
  asOf: string,
): Map<string, TrustAsOf> {
  const later = new Map<string, TrustAsOf>();
  const bump = (id: string, k: keyof TrustAsOf, v: number) => {
    const cur = later.get(id) ?? { utilised: 0, disbursed: 0 };
    cur[k] += v;
    later.set(id, cur);
  };
  const byId = new Map(obligations.map((o) => [o.id, o]));
  for (const o of obligations) {
    if (!COMMITTED.has(o.status) || o.obrDate <= asOf) continue;
    for (const l of o.lines ?? [])
      if (l.trustProgramId) bump(l.trustProgramId, 'utilised', l.amount);
  }
  for (const v of vouchers) {
    if (!(v.status === 'PAID' || v.status === 'CLOSED') || v.dvDate <= asOf) continue;
    const o = v.obligationId ? byId.get(v.obligationId) : undefined;
    const lines = (o?.lines ?? []).filter((l) => l.trustProgramId);
    const base = lines.reduce((t, l) => t + l.amount, 0);
    if (!base) continue;
    let left = v.grossAmount;
    lines.forEach((l, i) => {
      const share = i === lines.length - 1 ? left : Math.round((v.grossAmount * l.amount) / base);
      left -= share;
      bump(l.trustProgramId as string, 'disbursed', share);
    });
  }
  return new Map(
    programs.map((p) => {
      const l = later.get(p.id) ?? { utilised: 0, disbursed: 0 };
      return [
        p.id,
        {
          utilised: Math.max(0, (p.utilised ?? 0) - l.utilised),
          disbursed: Math.max(0, (p.disbursed ?? 0) - l.disbursed),
        },
      ];
    }),
  );
}

// ===========================================================================
// Form 8 - LDRRMF Utilization
// ===========================================================================

/** What Form 8 reads of a budget line. */
export type Form8Line = Pick<
  BudgetBalance,
  | 'sector'
  | 'fppName'
  | 'accountName'
  | 'expenseClass'
  | 'appropriationRevised'
  | 'appropriationContinuing'
  | 'obligated'
>;

/**
 * Patch 164 - the General Fund's budget lines as they stood at `asOf`, worked
 * from the documents rather than read off the running balances: every
 * approved appropriation enacted by then (the original budget always; a
 * supplemental, realignment or continuing one by its authority date), and
 * every obligation committed by then.
 */
export function budgetLinesAsOf(
  appropriations: Array<
    Pick<
      Appropriation,
      | 'kind'
      | 'status'
      | 'amount'
      | 'authorityDate'
      | 'postedAt'
      | 'officeId'
      | 'fppCode'
      | 'accountCode'
      | 'fppName'
      | 'accountName'
      | 'sector'
      | 'expenseClass'
    >
  >,
  obligations: ObligationLike[],
  asOf: string,
): Form8Line[] {
  const map = new Map<string, Form8Line>();
  const at = (k: string, seed: Partial<Form8Line>) => {
    let row = map.get(k);
    if (!row) {
      row = {
        sector: '',
        fppName: '',
        accountName: '',
        expenseClass: 'MOOE',
        appropriationRevised: 0,
        appropriationContinuing: 0,
        obligated: 0,
        ...seed,
      } as Form8Line;
      map.set(k, row);
    }
    return row;
  };
  for (const a of appropriations) {
    if (a.status !== 'APPROVED') continue;
    const dated = a.authorityDate || String(a.postedAt ?? '').slice(0, 10);
    if (a.kind !== 'ORIGINAL' && dated && dated > asOf) continue;
    const row = at(
      lineKey({ officeId: a.officeId, fppCode: a.fppCode ?? '', accountCode: a.accountCode ?? '' }),
      {
        sector: a.sector,
        fppName: a.fppName,
        accountName: a.accountName,
        expenseClass: a.expenseClass,
      },
    );
    row.appropriationRevised += a.amount;
    if (a.kind === 'CONTINUING') row.appropriationContinuing += a.amount;
  }
  for (const o of obligations) {
    if (!COMMITTED.has(o.status) || o.obrDate > asOf) continue;
    for (const l of o.lines ?? []) {
      const k = lineKey({
        officeId: l.officeId ?? '',
        fppCode: l.fppCode ?? '',
        accountCode: l.appropriatedAccountCode ?? '',
      });
      const row = map.get(k);
      // An obligation against a line with no appropriation is not this report's.
      if (row) row.obligated += l.amount;
    }
  }
  return [...map.values()];
}

export const isLdrrmfLine = (b: Pick<BudgetBalance, 'sector' | 'fppName'>) =>
  /^\s*L?DRRMF?\s*$/i.test(b.sector ?? '') ||
  /DRRM/i.test(b.sector ?? '') ||
  /LDRRM/i.test(b.fppName ?? '');

export const isQrf = (text: string) => /QUICK RESPONSE|\bQRF\b/i.test(text);

/** A line with both columns: the 30% Quick Response Fund and the 70%. */
export interface Form8Amounts {
  qrf: number;
  seventy: number;
}

export interface Form8Item extends Form8Amounts {
  label: string;
  budget: number;
  remaining: number;
}

export interface Form8Group {
  label: string;
  items: Form8Item[];
}

export interface Form8Section {
  code: string;
  label: string;
  groups: Form8Group[];
  total: Form8Amounts;
}

export interface Form8 {
  sources: Array<{ label: string; indent?: boolean } & Form8Amounts>;
  totalAvailable: Form8Amounts;
  utilization: Form8Section[];
  totalUtilization: Form8Amounts;
  unutilized: Form8Amounts;
}

const CLASS_LABEL: Record<string, string> = {
  PS: 'Personal Services',
  MOOE: 'Maintenance and Other Operating Expenses',
  FE: 'Financial Expenses',
  CO: 'Capital Outlay',
};

const add = (a: Form8Amounts, b: Form8Amounts): Form8Amounts => ({
  qrf: a.qrf + b.qrf,
  seventy: a.seventy + b.seventy,
});
const ZERO: Form8Amounts = { qrf: 0, seventy: 0 };
const split = (qrf: boolean, v: number): Form8Amounts =>
  qrf ? { qrf: v, seventy: 0 } : { qrf: 0, seventy: v };

function lineLabel(b: Pick<Form8Line, 'fppName' | 'accountName'>): string {
  const f = (b.fppName ?? '').trim();
  const a = (b.accountName ?? '').trim();
  if (f && a && f.toUpperCase() !== a.toUpperCase()) return `${f} - ${a}`;
  return f || a || 'Unnamed line';
}

export function buildForm8(input: {
  /** The General Fund's budget lines of the year (budgetLinesAsOf). */
  balances: Form8Line[];
  /** The Trust Fund programmes (the LDRRMF in the Special Trust Fund is among them). */
  trustPrograms: TrustProgram[];
  year: number;
  /** Patch 164: the programmes' figures at the quarter's end. */
  trustAsOf?: Map<string, TrustAsOf>;
}): Form8 {
  const lines = input.balances.filter(isLdrrmfLine);
  const continuing = (b: Form8Line) =>
    (b.appropriationContinuing ?? 0) > 0 &&
    (b.appropriationRevised ?? 0) - (b.appropriationContinuing ?? 0) <= 0;

  const current = lines.filter((b) => !continuing(b));
  const carried = lines.filter(continuing);
  const stf = input.trustPrograms.filter(
    (p) => trustSourceOf(p).source === 'LDRRMF' && (!p.startYear || p.startYear <= input.year),
  );

  const sumBudget = (ls: Form8Line[]) =>
    ls.reduce((t, b) => add(t, split(isQrf(lineLabel(b)), b.appropriationRevised ?? 0)), ZERO);

  const stfByYear = new Map<string, Form8Amounts>();
  for (const p of stf) {
    const y = p.startYear ? String(p.startYear) : 'Prior years';
    stfByYear.set(y, add(stfByYear.get(y) ?? ZERO, split(isQrf(p.programName), p.programmed)));
  }

  const sources: Form8['sources'] = [
    { label: 'Current Appropriations', ...sumBudget(current) },
    { label: 'Continuing Appropriations', ...sumBudget(carried) },
    { label: "Previous Year's Appropriations transferred to the Special Trust Fund", ...ZERO },
    ...[...stfByYear.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([y, v]) => ({ label: `STF ${y}`, indent: true, ...v })),
    { label: 'Transfers/Grants', ...ZERO },
  ];
  const totalAvailable = sources.reduce((t, s) => add(t, s), ZERO);

  const groupLines = (ls: Form8Line[]): Form8Group[] => {
    const groups = new Map<string, Form8Item[]>();
    for (const b of ls) {
      const label = lineLabel(b);
      const q = isQrf(label);
      const g = q ? 'Quick Response Fund' : (CLASS_LABEL[b.expenseClass] ?? b.expenseClass);
      const used = b.obligated ?? 0;
      const item: Form8Item = {
        label,
        ...split(q, used),
        budget: b.appropriationRevised ?? 0,
        remaining: (b.appropriationRevised ?? 0) - used,
      };
      groups.set(g, [...(groups.get(g) ?? []), item]);
    }
    const order = ['Quick Response Fund', ...Object.values(CLASS_LABEL)];
    return [...groups.entries()]
      .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
      .map(([label, items]) => ({
        label,
        items: items.sort((x, y) => x.label.localeCompare(y.label)),
      }));
  };

  const total = (groups: Form8Group[]) =>
    groups.reduce((t, g) => g.items.reduce((u, i) => add(u, i), t), ZERO);

  const b1 = groupLines(current);
  const b2 = groupLines(carried);
  const b3: Form8Group[] = stf.length
    ? [
        {
          label: 'Special Trust Fund',
          items: stf
            .map((p) => {
              const used = input.trustAsOf?.get(p.id)?.utilised ?? p.utilised ?? 0;
              return {
                label: `${p.programCode} - ${p.programName}`,
                ...split(isQrf(p.programName), used),
                budget: p.programmed,
                remaining: p.programmed - used,
              };
            })
            .sort((x, y) => x.label.localeCompare(y.label)),
        },
      ]
    : [];

  const utilization: Form8Section[] = [
    { code: 'B.1', label: 'Utilization of Current Appropriations', groups: b1, total: total(b1) },
    {
      code: 'B.2',
      label: 'Utilization of Continuing Appropriations',
      groups: b2,
      total: total(b2),
    },
    { code: 'B.3', label: 'Utilization of the Special Trust Fund', groups: b3, total: total(b3) },
    { code: 'B.4', label: 'Utilization of Transfers/Grants', groups: [], total: ZERO },
  ];
  const totalUtilization = utilization.reduce((t, s) => add(t, s.total), ZERO);
  return {
    sources,
    totalAvailable,
    utilization,
    totalUtilization,
    unutilized: {
      qrf: totalAvailable.qrf - totalUtilization.qrf,
      seventy: totalAvailable.seventy - totalUtilization.seventy,
    },
  };
}

// ===========================================================================
// Form 9 - Statement of Cash Flows (BLGF MC 09-2012, Annex 2)
// ===========================================================================

export type Form9Key =
  | 'TAXPAYERS'
  | 'IRA'
  | 'SALES'
  | 'INTEREST'
  | 'DIVIDEND'
  | 'OTHER_RECEIPTS'
  | 'EXPENSES'
  | 'SUPPLIERS'
  | 'EMPLOYEES'
  | 'INTEREST_EXPENSE'
  | 'OTHER_EXPENSES'
  | 'SALE_PPE'
  | 'SALE_DEBT'
  | 'COLLECT_LOANS'
  | 'BUY_PPE'
  | 'BUY_DEBT'
  | 'GRANT_LOANS'
  | 'ISSUE_DEBT'
  | 'LOANS'
  | 'RETIRE_DEBT'
  | 'AMORTIZATION';

type Section = 'OPERATING' | 'INVESTING' | 'FINANCING';

export const FORM9_LINES: Array<{
  key: Form9Key;
  section: Section;
  dir: 'IN' | 'OUT';
  label: string;
}> = [
  { key: 'TAXPAYERS', section: 'OPERATING', dir: 'IN', label: 'Collection from Taxpayers' },
  { key: 'IRA', section: 'OPERATING', dir: 'IN', label: 'Share from Internal Revenue Collections' },
  {
    key: 'SALES',
    section: 'OPERATING',
    dir: 'IN',
    label: 'Receipts from Sale of Goods or Services',
  },
  { key: 'INTEREST', section: 'OPERATING', dir: 'IN', label: 'Interest Income' },
  { key: 'DIVIDEND', section: 'OPERATING', dir: 'IN', label: 'Dividend Income' },
  { key: 'OTHER_RECEIPTS', section: 'OPERATING', dir: 'IN', label: 'Other Receipts' },
  { key: 'EXPENSES', section: 'OPERATING', dir: 'OUT', label: 'To Expenses' },
  { key: 'SUPPLIERS', section: 'OPERATING', dir: 'OUT', label: 'To Suppliers/Creditors' },
  { key: 'EMPLOYEES', section: 'OPERATING', dir: 'OUT', label: 'To Employees' },
  { key: 'INTEREST_EXPENSE', section: 'OPERATING', dir: 'OUT', label: 'Interest Expense' },
  { key: 'OTHER_EXPENSES', section: 'OPERATING', dir: 'OUT', label: 'Other Expenses' },
  {
    key: 'SALE_PPE',
    section: 'INVESTING',
    dir: 'IN',
    label: 'From Sale of Property, Plant and Equipment',
  },
  {
    key: 'SALE_DEBT',
    section: 'INVESTING',
    dir: 'IN',
    label: 'From Sale of Debt Securities of Other Entities',
  },
  {
    key: 'COLLECT_LOANS',
    section: 'INVESTING',
    dir: 'IN',
    label: 'From Collection of Principal on Loans to Other Entities',
  },
  {
    key: 'BUY_PPE',
    section: 'INVESTING',
    dir: 'OUT',
    label: 'To Purchase Property, Plant and Equipment',
  },
  {
    key: 'BUY_DEBT',
    section: 'INVESTING',
    dir: 'OUT',
    label: 'To Purchase Debt Securities of Other Entities',
  },
  {
    key: 'GRANT_LOANS',
    section: 'INVESTING',
    dir: 'OUT',
    label: 'To Grant/Make Loans to Other Entities',
  },
  { key: 'ISSUE_DEBT', section: 'FINANCING', dir: 'IN', label: 'From Issuance of Debt Securities' },
  { key: 'LOANS', section: 'FINANCING', dir: 'IN', label: 'From Acquisition of Loan' },
  {
    key: 'RETIRE_DEBT',
    section: 'FINANCING',
    dir: 'OUT',
    label: 'Retirement/Redemption of Debt Securities',
  },
  { key: 'AMORTIZATION', section: 'FINANCING', dir: 'OUT', label: 'Payment of Loan Amortization' },
];

/** Which Annex 2 line a caption of the GAM statement goes on. */
export function form9KeyFor(section: Section, dir: 'IN' | 'OUT', caption: string): Form9Key {
  const c = caption.toLowerCase();
  if (section === 'OPERATING' && dir === 'IN') {
    if (/taxpayer/.test(c)) return 'TAXPAYERS';
    if (/internal revenue/.test(c)) return 'IRA';
    if (/business|service income|sale of goods/.test(c)) return 'SALES';
    if (/^interest income/.test(c)) return 'INTEREST';
    if (/dividend/.test(c)) return 'DIVIDEND';
    return 'OTHER_RECEIPTS';
  }
  if (section === 'OPERATING') {
    if (/payment of expenses|^payments? to expenses/.test(c)) return 'EXPENSES';
    if (/supplier|creditor/.test(c)) return 'SUPPLIERS';
    if (/employee/.test(c)) return 'EMPLOYEES';
    if (/interest expense/.test(c)) return 'INTEREST_EXPENSE';
    return 'OTHER_EXPENSES';
  }
  if (section === 'INVESTING' && dir === 'IN') {
    if (/loan/.test(c)) return 'COLLECT_LOANS';
    if (/non-current investment|debt/.test(c)) return 'SALE_DEBT';
    return 'SALE_PPE';
  }
  if (section === 'INVESTING') {
    if (/grant of loan|loan/.test(c)) return 'GRANT_LOANS';
    if (/^investment$|debt/.test(c)) return 'BUY_DEBT';
    return 'BUY_PPE';
  }
  if (dir === 'IN') return /bond|debt/.test(c) ? 'ISSUE_DEBT' : 'LOANS';
  return /retirement|redemption/.test(c) ? 'RETIRE_DEBT' : 'AMORTIZATION';
}

export interface Form9 {
  /** Inflows positive, outflows negative. */
  amounts: Record<Form9Key, number>;
  totals: Record<Section, { in: number; out: number; net: number }>;
  netIncrease: number;
  opening: number;
  closing: number;
  /** False when a fund's statement does not tie to its ledger. */
  tiesOut: boolean;
}

function amountsOf(statements: CashFlowStatement[]): Record<Form9Key, number> {
  const out = Object.fromEntries(FORM9_LINES.map((l) => [l.key, 0])) as Record<Form9Key, number>;
  for (const st of statements) {
    for (const block of st.blocks) {
      for (const r of block.inflows) out[form9KeyFor(block.section, 'IN', r.caption)] += r.amount;
      for (const r of block.outflows) out[form9KeyFor(block.section, 'OUT', r.caption)] -= r.amount;
    }
  }
  return out;
}

/**
 * The three funds' statements, year to date through the quarter. With the
 * statements through the PREVIOUS quarter as well, the figures are the
 * quarter's own: this year to date, less last quarter's year to date.
 */
export function buildForm9(current: CashFlowStatement[], previous?: CashFlowStatement[]): Form9 {
  const now = amountsOf(current);
  const before = previous ? amountsOf(previous) : null;
  const amounts = Object.fromEntries(
    FORM9_LINES.map((l) => [l.key, now[l.key] - (before ? before[l.key] : 0)]),
  ) as Record<Form9Key, number>;

  const totals = {} as Form9['totals'];
  for (const s of ['OPERATING', 'INVESTING', 'FINANCING'] as Section[]) {
    const ins = FORM9_LINES.filter((l) => l.section === s && l.dir === 'IN').reduce(
      (t, l) => t + amounts[l.key],
      0,
    );
    const outs = FORM9_LINES.filter((l) => l.section === s && l.dir === 'OUT').reduce(
      (t, l) => t + amounts[l.key],
      0,
    );
    totals[s] = { in: ins, out: outs, net: ins + outs };
  }
  const netIncrease = totals.OPERATING.net + totals.INVESTING.net + totals.FINANCING.net;
  const opening = previous
    ? previous.reduce((t, s) => t + s.closingCash, 0)
    : current.reduce((t, s) => t + s.openingCash, 0);
  return {
    amounts,
    totals,
    netIncrease,
    opening,
    closing: opening + netIncrease,
    tiesOut: current.every((s) => s.tiesOut) && (previous ?? []).every((s) => s.tiesOut),
  };
}

// ===========================================================================
// Form 11 - SEF Utilization
// ===========================================================================

export interface Form11 {
  receipts: number;
  classes: Array<{
    label: string;
    objects: Array<{ name: string; amount: number }>;
    total: number;
  }>;
  subtotal: number;
  balance: number;
}

/** PS, MOOE or CO, from the object's account code. */
export function expenseClassOfAccount(code: string): 'PS' | 'MOOE' | 'CO' | null {
  if (code.startsWith('501')) return 'PS';
  if (code.startsWith('5')) return 'MOOE';
  // An asset bought - property, plant and equipment, semi-expendables, inventory.
  if (code.startsWith('1') && !code.startsWith('101') && !code.startsWith('103')) return 'CO';
  return null;
}

export function buildForm11(input: {
  receipts: number;
  /** The SEF vouchers paid in the period, with their debit lines. */
  vouchers: Array<{ lines: Array<{ accountCode: string; accountName: string; debit: number }> }>;
}): Form11 {
  const by: Record<'PS' | 'MOOE' | 'CO', Map<string, number>> = {
    PS: new Map(),
    MOOE: new Map(),
    CO: new Map(),
  };
  for (const v of input.vouchers) {
    for (const l of v.lines) {
      if (!(l.debit > 0)) continue;
      const cls = expenseClassOfAccount(String(l.accountCode ?? ''));
      if (!cls) continue;
      const name = l.accountName || l.accountCode;
      by[cls].set(name, (by[cls].get(name) ?? 0) + l.debit);
    }
  }
  const classes = (['PS', 'MOOE', 'CO'] as const).map((k) => {
    const objects = [...by[k].entries()]
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { label: CLASS_LABEL[k], objects, total: objects.reduce((t, o) => t + o.amount, 0) };
  });
  const subtotal = classes.reduce((t, c) => t + c.total, 0);
  return { receipts: input.receipts, classes, subtotal, balance: input.receipts - subtotal };
}

// ===========================================================================
// Form 12 - Unliquidated Cash Advances
// ===========================================================================

export const FORM12_BUCKETS = [
  'Less than 30 days',
  '31-90 days',
  '91-365 days',
  'Over 1 year',
  'Over 2 years',
  '3 years and above',
] as const;

const addYears = (date: string, n: number) => `${Number(date.slice(0, 4)) + n}${date.slice(4)}`;

/** Which aging column an advance granted on `granted` falls in at `asOf`. */
export function ageBucket(granted: string, asOf: string): number {
  if (addYears(granted, 3) <= asOf) return 5;
  if (addYears(granted, 2) < asOf) return 4;
  if (addYears(granted, 1) < asOf) return 3;
  const days = Math.round((Date.parse(asOf) - Date.parse(granted)) / 86_400_000);
  if (days <= 30) return 0;
  if (days <= 90) return 1;
  return 2;
}

export interface Form12Row {
  id: string;
  name: string;
  balance: number;
  dateGranted: string;
  purpose: string;
  fundCode: string;
  bucket: number;
}

export function buildForm12(
  advances: Array<{
    id: string;
    accountableOfficerName: string;
    outstandingBalance: number;
    dateGranted: string;
    purpose: string;
    fundCode: string;
  }>,
  asOf: string,
): { rows: Form12Row[]; buckets: number[]; total: number } {
  const rows = advances
    .filter((a) => a.outstandingBalance > 0 && (!a.dateGranted || a.dateGranted <= asOf))
    .map((a) => ({
      id: a.id,
      name: (a.accountableOfficerName || 'Officer not named').toUpperCase(),
      balance: a.outstandingBalance,
      dateGranted: a.dateGranted,
      purpose: a.purpose,
      fundCode: a.fundCode,
      bucket: a.dateGranted ? ageBucket(a.dateGranted, asOf) : 5,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.dateGranted.localeCompare(b.dateGranted));
  const buckets = FORM12_BUCKETS.map((_, i) =>
    rows.filter((r) => r.bucket === i).reduce((t, r) => t + r.balance, 0),
  );
  return { rows, buckets, total: rows.reduce((t, r) => t + r.balance, 0) };
}
