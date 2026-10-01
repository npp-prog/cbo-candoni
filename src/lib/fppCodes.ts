/**
 * The function/program/project codes, as the GAM prescribes them.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS LIST COMES FROM
 * ---------------------------------------------------------------------------
 * Government Accounting Manual for Local Government Units, Volume III (the
 * Chart of Accounts), Annex A - "Functional Classification of Expenditures and
 * Transfers" - together with the eight sector codes in Chapter 1, Section 3.
 *
 * Every registry the GAM prescribes is headed "Function/Program/Project
 * (F.P.P.)", and Volume I, Section 12 says a registry is maintained for each
 * office/project under each service in each functional classification. So the
 * code is not decoration on an appropriation line: it is what decides which
 * registry sheet the line belongs to.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS CODE AND NOT MASTER DATA
 * ---------------------------------------------------------------------------
 * The same reason the SRE buckets are code (see sectors.ts). This list is
 * national. COA revises it; Candoni does not. A table somebody can edit
 * invites a hundred-and-thirty-ninth code invented on a Tuesday, and the
 * registry it lands in would then answer to nothing.
 *
 * The municipality's OWN structure - its programmes, projects and activities -
 * is master data and lives in the PPA screens. This is the statutory frame
 * those hang off, not a replacement for them.
 *
 * ---------------------------------------------------------------------------
 * THE OFFICE IS THE GROUP HEADING, NOT THE CODE
 * ---------------------------------------------------------------------------
 * Nineteen of the hundred and thirty-eight entries are called "General
 * Administration", so the name alone identifies nothing. What tells them apart
 * is the heading they sit under in Annex A: 1081 is General Administration
 * under "Accounting Services (Accountant)", 1091 the same under "Treasury
 * Services (Treasurer)".
 *
 * That heading is carried here as `office`, and it is the half of the label a
 * reader actually needs. Anything that shows a code to a person shows both -
 * `fppLabel` does it in one place so no screen has to remember.
 *
 * A caution worth recording: the GAM gives a FUNCTION code, not an office
 * code. There is no code in any of the three volumes for the Sangguniang
 * Bayan as an entity, nor for the Office of the Mayor as an entity - the
 * legislature appears only as its functions, 1021 Legislation and 1022
 * Support Services (Secretariat). If CFMS ever needs a per-office code, it has
 * to come from the DBM budget circulars, and not from here.
 */

export interface Violation {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface CheckResult {
  ok: boolean;
  violations: Violation[];
}

/** A four-digit functional classification code. */
export const FPP_CODE = /^\d{4}$/;

/** The eight sectors of Annex A. There is no 2000; the GAM does not use one. */
export type FppSectorCode = '1000' | '3000' | '4000' | '5000' | '6000' | '7000' | '8000' | '9000';

export const FPP_SECTORS: Record<FppSectorCode, string> = {
  '1000': 'General Public Services',
  '3000': 'Education, Culture, Sports and Manpower Services',
  '4000': 'Health Services',
  '5000': 'Labor and Employment',
  '6000': 'Housing and Community Development',
  '7000': 'Social Welfare Services',
  '8000': 'Economic Services',
  '9000': 'Other Purposes',
};

export interface FppCode {
  /** The four-digit code, e.g. "8751". */
  code: string;
  /** The sector it belongs to; always the code's first digit followed by 000. */
  sector: FppSectorCode;
  /** The Annex A group heading - the office or service the function sits under. */
  office: string;
  /** The function itself, e.g. "General Administration". */
  name: string;
}

/**
 * Annex A in full: 138 codes, in the order the manual prints them.
 *
 * The order is the manual's and is preserved deliberately - a picker that
 * lists them this way reads like the page the user knows.
 */
export const FPP_CODES: FppCode[] = [
  // Executive Services (Governor/Mayor)
  { code: '1011', sector: '1000', office: 'Executive Services (Governor/Mayor)', name: 'General Administration' },
  { code: '1012', sector: '1000', office: 'Executive Services (Governor/Mayor)', name: 'Maintenance of Prisoners' },
  { code: '1013', sector: '1000', office: 'Executive Services (Governor/Mayor)', name: 'Civil Security' },
  { code: '1014', sector: '1000', office: 'Executive Services (Governor/Mayor)', name: 'Barangay Secretariat' },
  { code: '1015', sector: '1000', office: 'Executive Services (Governor/Mayor)', name: 'License Inspection Service' },
  { code: '1016', sector: '1000', office: 'Executive Services (Governor/Mayor)', name: 'Vice Governor/Mayor' },
  // Legislative Services
  { code: '1021', sector: '1000', office: 'Legislative Services', name: 'Legislation' },
  { code: '1022', sector: '1000', office: 'Legislative Services', name: 'Support Services (Secretariat)' },
  // Administrative Services (Administrator)
  { code: '1031', sector: '1000', office: 'Administrative Services (Administrator)', name: 'General Administration' },
  { code: '1032', sector: '1000', office: 'Administrative Services (Administrator)', name: 'Personnel Officer' },
  // Planning and Development Coordination
  { code: '1041', sector: '1000', office: 'Planning and Development Coordination', name: 'General Administration' },
  // Civil Registry (Civil Registrar)
  { code: '1051', sector: '1000', office: 'Civil Registry (Civil Registrar)', name: 'General Administration' },
  // General Services (General Services Office)
  { code: '1061', sector: '1000', office: 'General Services (General Services Office)', name: 'General Administration' },
  // Budgeting Services (Budget Officer)
  { code: '1071', sector: '1000', office: 'Budgeting Services (Budget Officer)', name: 'General Administration' },
  // Accounting Services (Accountant)
  { code: '1081', sector: '1000', office: 'Accounting Services (Accountant)', name: 'General Administration' },
  // Treasury Services (Treasurer)
  { code: '1091', sector: '1000', office: 'Treasury Services (Treasurer)', name: 'General Administration' },
  // Assessment of Real Property (Assessor)
  { code: '1101', sector: '1000', office: 'Assessment of Real Property (Assessor)', name: 'General Administration' },
  { code: '1102', sector: '1000', office: 'Assessment of Real Property (Assessor)', name: 'Real Property Tax Administration (Tax Mapping, Revision of Assessment, etc.)' },
  // Auditing Services (Auditor)
  { code: '1111', sector: '1000', office: 'Auditing Services (Auditor)', name: 'General Administration' },
  // Information Services
  { code: '1121', sector: '1000', office: 'Information Services', name: 'General Administration' },
  { code: '1122', sector: '1000', office: 'Information Services', name: 'Library Services' },
  // Legal Services (Attorney/Legal Officer)
  { code: '1131', sector: '1000', office: 'Legal Services (Attorney/Legal Officer)', name: 'General Administration' },
  // Prosecution Services
  { code: '1141', sector: '1000', office: 'Prosecution Services', name: 'General Administration' },
  // Administration of Justice (Lower Court)
  { code: '1151', sector: '1000', office: 'Administration of Justice (Lower Court)', name: 'Regional Trial Court' },
  { code: '1152', sector: '1000', office: 'Administration of Justice (Lower Court)', name: 'Municipal Circuit Trial Court' },
  { code: '1158', sector: '1000', office: 'Administration of Justice (Lower Court)', name: 'Metropolitan/Municipal Trial Court' },
  // Land Registration Services (Register of Deeds)
  { code: '1161', sector: '1000', office: 'Land Registration Services (Register of Deeds)', name: 'General Administration' },
  // Mining Claim Registration Services (Mining Recorder)
  { code: '1171', sector: '1000', office: 'Mining Claim Registration Services (Mining Recorder)', name: 'General Administration' },
  // Police Services
  { code: '1181', sector: '1000', office: 'Police Services', name: 'General Administration' },
  // Fire Protection Services
  { code: '1191', sector: '1000', office: 'Fire Protection Services', name: 'General Administration' },
  // Local Disaster Risk Reduction and Management Office
  { code: '1201', sector: '1000', office: 'Local Disaster Risk Reduction and Management Office', name: 'General Administration' },
  // Miscellaneous General Public Services
  { code: '1991', sector: '1000', office: 'Miscellaneous General Public Services', name: 'Election Reserve' },
  { code: '1992', sector: '1000', office: 'Miscellaneous General Public Services', name: 'Sinking Fund Contributions' },
  { code: '1999', sector: '1000', office: 'Miscellaneous General Public Services', name: 'Others' },
  // School Supervision (Superintendent of Schools)
  { code: '3311', sector: '3000', office: 'School Supervision (Superintendent of Schools)', name: 'General Administration' },
  // Public Education
  { code: '3321', sector: '3000', office: 'Public Education', name: 'Elementary Schools' },
  { code: '3322', sector: '3000', office: 'Public Education', name: 'Secondary Schools' },
  { code: '3323', sector: '3000', office: 'Public Education', name: 'University/College Education' },
  { code: '3324', sector: '3000', office: 'Public Education', name: 'Vocational/Technical School' },
  { code: '3325', sector: '3000', office: 'Public Education', name: 'Adult Education' },
  // Education Subsidiary Services
  { code: '3331', sector: '3000', office: 'Education Subsidiary Services', name: 'Medical Subsidiary Services' },
  // Manpower Development
  { code: '3351', sector: '3000', office: 'Manpower Development', name: 'Management Tool (Seminar Expenditures and Training Projects)' },
  // Maintenance of Sports Centers, Athletic Fields, Playgrounds
  { code: '3361', sector: '3000', office: 'Maintenance of Sports Centers, Athletic Fields, Playgrounds', name: 'General Administration' },
  // Operation of Cultural/Conference/Convention Center
  { code: '3371', sector: '3000', office: 'Operation of Cultural/Conference/Convention Center', name: 'General Administration' },
  // Other Education, Sports and Manpower Development Services
  { code: '3391', sector: '3000', office: 'Other Education, Sports and Manpower Development Services', name: 'Cultural Projects' },
  { code: '3392', sector: '3000', office: 'Other Education, Sports and Manpower Development Services', name: 'Sports Development/Physical Fitness' },
  { code: '3399', sector: '3000', office: 'Other Education, Sports and Manpower Development Services', name: 'Sundry Educational Services' },
  // Local Development Fund
  { code: '3918', sector: '3000', office: 'Local Development Fund', name: 'Purchase, Construction And Improvement of Government Facilities – Education, Culture, Sports and Manpower Development' },
  { code: '3999', sector: '3000', office: 'Local Development Fund', name: 'Others' },
  // Health Services (Health Officer)
  { code: '4411', sector: '4000', office: 'Health Services (Health Officer)', name: 'General Administration' },
  { code: '4412', sector: '4000', office: 'Health Services (Health Officer)', name: 'Field Projects (Immunization, Inoculation, Blood Donor Services, etc.)' },
  { code: '4413', sector: '4000', office: 'Health Services (Health Officer)', name: 'Day Care Clinic' },
  // Hospital
  { code: '4421', sector: '4000', office: 'Hospital', name: 'General Administration' },
  // Chest Clinic
  { code: '4431', sector: '4000', office: 'Chest Clinic', name: 'General Administration' },
  // Local Development Fund
  { code: '4918', sector: '4000', office: 'Local Development Fund', name: 'Purchase, Construction and Improvement of Government Facilities - Health' },
  { code: '4919', sector: '4000', office: 'Local Development Fund', name: 'Others' },
  // Miscellaneous Health Services
  { code: '4999', sector: '4000', office: 'Miscellaneous Health Services', name: 'Others' },
  // Miscellaneous, Labor and Employment
  { code: '5999', sector: '5000', office: 'Miscellaneous, Labor and Employment', name: 'Others' },
  // Housing Projects
  { code: '6511', sector: '6000', office: 'Housing Projects', name: 'General Administration' },
  // Sanitary Services
  { code: '6521', sector: '6000', office: 'Sanitary Services', name: 'Street Cleaning' },
  { code: '6522', sector: '6000', office: 'Sanitary Services', name: 'Garbage Collections' },
  { code: '6523', sector: '6000', office: 'Sanitary Services', name: 'Sewerage and Drainage System' },
  // Street Lighting
  { code: '6531', sector: '6000', office: 'Street Lighting', name: 'General Administration' },
  // Community Development
  { code: '6541', sector: '6000', office: 'Community Development', name: 'General Administration' },
  { code: '6542', sector: '6000', office: 'Community Development', name: 'Resettlement, Zonal Improvement Projects, Urban and Rural Renewal, etc.' },
  { code: '6543', sector: '6000', office: 'Community Development', name: 'Beautification' },
  { code: '6544', sector: '6000', office: 'Community Development', name: 'Maintenance of Plazas, Parks and Monuments' },
  // Local Development Fund
  { code: '6911', sector: '6000', office: 'Local Development Fund', name: 'Community Development Projects' },
  { code: '6918', sector: '6000', office: 'Local Development Fund', name: 'Purchase, Construction and Improvement of Government Facilities - Housing and Community Development' },
  { code: '6919', sector: '6000', office: 'Local Development Fund', name: 'Other Community/Environmental Projects' },
  // Miscellaneous Housing and Community Development
  { code: '6999', sector: '6000', office: 'Miscellaneous Housing and Community Development', name: 'Others' },
  // Social Welfare Services (Social Welfare & Development Officer)
  { code: '7611', sector: '7000', office: 'Social Welfare Services (Social Welfare & Development Officer)', name: 'General Administration' },
  // Family Planning Services (Population Officer)
  { code: '7621', sector: '7000', office: 'Family Planning Services (Population Officer)', name: 'General Administration' },
  // Local Development Fund
  { code: '7918', sector: '7000', office: 'Local Development Fund', name: 'Purchase, Construction and Improvement of Government Facilities – Social Services' },
  // Miscellaneous, Other Social Services
  { code: '7999', sector: '7000', office: 'Miscellaneous, Other Social Services', name: 'Others' },
  // Agricultural Services
  { code: '8711', sector: '8000', office: 'Agricultural Services', name: 'General Administration (Agriculturist)' },
  { code: '8712', sector: '8000', office: 'Agricultural Services', name: 'Extension and On-site Research Services' },
  { code: '8713', sector: '8000', office: 'Agricultural Services', name: 'Demonstration/Farm Nurseries' },
  { code: '8714', sector: '8000', office: 'Agricultural Services', name: 'Operation of Farm Equipment Pool' },
  { code: '8715', sector: '8000', office: 'Agricultural Services', name: 'Quality Control of Agricultural Products' },
  { code: '8716', sector: '8000', office: 'Agricultural Services', name: 'Irrigation System' },
  // Veterinary Services (Veterinarian)
  { code: '8721', sector: '8000', office: 'Veterinary Services (Veterinarian)', name: 'General Administration' },
  // Officer)
  { code: '8731', sector: '8000', office: 'Officer)', name: 'General Administration' },
  // Architectural Services (Architect)
  { code: '8741', sector: '8000', office: 'Architectural Services (Architect)', name: 'General Administration' },
  // Engineering Services
  { code: '8751', sector: '8000', office: 'Engineering Services', name: 'General Administration' },
  { code: '8752', sector: '8000', office: 'Engineering Services', name: 'Construction' },
  { code: '8753', sector: '8000', office: 'Engineering Services', name: 'Maintenance' },
  { code: '8754', sector: '8000', office: 'Engineering Services', name: 'Operation of Motor Pool' },
  { code: '8755', sector: '8000', office: 'Engineering Services', name: 'Operation of Rock Crusher' },
  // Cooperative Services (Cooperative Officer)
  { code: '8761', sector: '8000', office: 'Cooperative Services (Cooperative Officer)', name: 'General Administration' },
  // Operation of Waterworks System
  { code: '8771', sector: '8000', office: 'Operation of Waterworks System', name: 'General Administration' },
  // Operation of Electric Light and Power System
  { code: '8781', sector: '8000', office: 'Operation of Electric Light and Power System', name: 'General Administration' },
  // Operation of Telephone System
  { code: '8791', sector: '8000', office: 'Operation of Telephone System', name: 'General Administration' },
  // Operation of Toll Roads, Bridges and Ferries
  { code: '8801', sector: '8000', office: 'Operation of Toll Roads, Bridges and Ferries', name: 'General Administration' },
  // Operation of Markets
  { code: '8811', sector: '8000', office: 'Operation of Markets', name: 'General Administration' },
  // Operation of Slaughterhouse
  { code: '8812', sector: '8000', office: 'Operation of Slaughterhouse', name: 'General Administration' },
  // Operation of Transportation System
  { code: '8821', sector: '8000', office: 'Operation of Transportation System', name: 'General Administration' },
  // Weather and Meteorological Services
  { code: '8831', sector: '8000', office: 'Weather and Meteorological Services', name: 'General Administration' },
  // Operation of Cemeteries
  { code: '8841', sector: '8000', office: 'Operation of Cemeteries', name: 'General Administration' },
  // Economic Development Programs
  { code: '8851', sector: '8000', office: 'Economic Development Programs', name: 'Agricultural Development Projects' },
  { code: '8852', sector: '8000', office: 'Economic Development Programs', name: 'Tourism Projects' },
  { code: '8853', sector: '8000', office: 'Economic Development Programs', name: 'Commercial Development Projects (Trade, Fair, etc.)' },
  { code: '8854', sector: '8000', office: 'Economic Development Programs', name: 'Industrial Development Projects (Cottage Industry, etc.)' },
  { code: '8855', sector: '8000', office: 'Economic Development Programs', name: 'Revolving Loan Fund' },
  { code: '8859', sector: '8000', office: 'Economic Development Programs', name: 'Other Economic Development Projects (Price Control Council, Cooperative Development, etc.)' },
  // Local Development Fund
  { code: '8911', sector: '8000', office: 'Local Development Fund', name: 'Agricultural Development Projects' },
  { code: '8912', sector: '8000', office: 'Local Development Fund', name: 'Tourism Development Projects' },
  { code: '8913', sector: '8000', office: 'Local Development Fund', name: 'Commercial Development Projects' },
  { code: '8914', sector: '8000', office: 'Local Development Fund', name: 'Industrial Development Projects' },
  { code: '8918', sector: '8000', office: 'Local Development Fund', name: 'Purchase, Construction and Improvement of Government Facilities - Economic Services' },
  { code: '8919', sector: '8000', office: 'Local Development Fund', name: 'Other Economic Development Projects' },
  // Energy Development Project
  { code: '8921', sector: '8000', office: 'Energy Development Project', name: 'General Administration' },
  // Livelihood Projects
  { code: '8931', sector: '8000', office: 'Livelihood Projects', name: 'General Administration' },
  // Miscellaneous Economic Services
  { code: '8991', sector: '8000', office: 'Miscellaneous Economic Services', name: 'Advances to Economic Enterprise' },
  { code: '8992', sector: '8000', office: 'Miscellaneous Economic Services', name: 'Investments' },
  { code: '8996', sector: '8000', office: 'Miscellaneous Economic Services', name: 'Interlocal Government Transfers for Economic Services' },
  { code: '8999', sector: '8000', office: 'Miscellaneous Economic Services', name: 'Others' },
  // Local Development Projects - Public Debt
  { code: '9911', sector: '9000', office: 'Local Development Projects - Public Debt', name: 'Loan Amortization - Domestic' },
  { code: '9912', sector: '9000', office: 'Local Development Projects - Public Debt', name: 'Loan Amortization - Foreign' },
  { code: '9913', sector: '9000', office: 'Local Development Projects - Public Debt', name: 'Interest Payments - Domestic' },
  { code: '9914', sector: '9000', office: 'Local Development Projects - Public Debt', name: 'Interest Payments - Foreign' },
  // Public Debt
  { code: '9921', sector: '9000', office: 'Public Debt', name: 'Loan Amortization - Domestic' },
  { code: '9922', sector: '9000', office: 'Public Debt', name: 'Loan Amortization - Foreign' },
  { code: '9923', sector: '9000', office: 'Public Debt', name: 'Interest Payments - Domestic' },
  { code: '9924', sector: '9000', office: 'Public Debt', name: 'Interest Payments - Foreign' },
  // Retirement and Other Benefits
  { code: '9931', sector: '9000', office: 'Retirement and Other Benefits', name: 'Lump-Sum Appropriations' },
  // Disaster Risk Reduction and Management
  { code: '9940', sector: '9000', office: 'Disaster Risk Reduction and Management', name: 'Disaster Risk Reduction and Management' },
  { code: '9941', sector: '9000', office: 'Disaster Risk Reduction and Management', name: 'Relief Recovery' },
  { code: '9942', sector: '9000', office: 'Disaster Risk Reduction and Management', name: 'Preparedness and Mitigation Projects Charged to Maintenance and Other Operating Expenses' },
  { code: '9943', sector: '9000', office: 'Disaster Risk Reduction and Management', name: 'Preparedness and Mitigation Projects Charged to Capital Outlay' },
  { code: '9944', sector: '9000', office: 'Disaster Risk Reduction and Management', name: 'Premiums on Calamity Insurance' },
  // Miscellaneous Other Purposes
  { code: '9992', sector: '9000', office: 'Miscellaneous Other Purposes', name: 'Inter-fund Transfers, Not Elsewhere Classified' },
  { code: '9993', sector: '9000', office: 'Miscellaneous Other Purposes', name: 'Aids to National Government Agencies' },
  { code: '9994', sector: '9000', office: 'Miscellaneous Other Purposes', name: 'Aids and Contributions to Governments Agencies Other than National and Local, Not Elsewhere Classified' },
  { code: '9995', sector: '9000', office: 'Miscellaneous Other Purposes', name: 'Interlocal Government Transfers, Not Elsewhere Classified' },
  { code: '9996', sector: '9000', office: 'Miscellaneous Other Purposes', name: 'Inter-special Account Transfers' },
  { code: '9997', sector: '9000', office: 'Miscellaneous Other Purposes', name: 'Aids to Non-Government Entities, Not Elsewhere Classified' },
  { code: '9999', sector: '9000', office: 'Miscellaneous Other Purposes', name: 'Others' },
];

const BY_CODE = new Map(FPP_CODES.map((f) => [f.code, f]));

/** The Annex A entry for a code, or undefined if the GAM does not define it. */
export function findFpp(code: string): FppCode | undefined {
  return BY_CODE.get(String(code ?? '').trim());
}

/**
 * The sector a code belongs to, read off its first digit.
 *
 * This works for a code the GAM does not list as well as one it does, which
 * is the point: a locally invented 8765 still belongs to Economic Services,
 * and the registry it lands in should say so rather than leaving it homeless.
 */
export function fppSectorOf(code: string): FppSectorCode | null {
  const c = String(code ?? '').trim();
  if (!FPP_CODE.test(c)) return null;
  const sector = `${c[0]}000`;
  return sector in FPP_SECTORS ? (sector as FppSectorCode) : null;
}

/**
 * How a code is written wherever a person reads it.
 *
 * Both halves, always. "1081 - General Administration" is ambiguous between
 * nineteen entries; "1081 - Accounting Services (Accountant): General
 * Administration" is not.
 */
export function fppLabel(code: string): string {
  const f = findFpp(code);
  if (!f) return code;
  return `${f.code} - ${f.office}: ${f.name}`;
}

/**
 * The codes matching a typed query, for a picker.
 *
 * Matches on the code, the office heading and the function name together, so
 * that typing "accountant", "1081" or "treasury" all find what the user means.
 * Order is Annex A's own.
 */
export function searchFpp(query: string, limit = 50): FppCode[] {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return FPP_CODES.slice(0, limit);
  const out: FppCode[] = [];
  for (const f of FPP_CODES) {
    const hay = `${f.code} ${f.office} ${f.name}`.toLowerCase();
    if (hay.includes(q)) out.push(f);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Whether a code may be used on a budget line.
 *
 * A code the GAM does not list is a WARNING, not a rejection. The municipality
 * may run a function Annex A has no entry for, and refusing the line would
 * stop the budget being recorded at all. What it must never be is silent: the
 * violation says the code is unknown so that whoever loads the appropriation
 * decides, rather than finding out when the registry does not foot.
 */
export function checkFppCode(code: string): CheckResult {
  const c = String(code ?? '').trim();
  const violations: Violation[] = [];

  if (!c) {
    violations.push({ code: 'FPP_MISSING', message: 'The line carries no F.P.P. code.' });
    return { ok: false, violations };
  }
  if (!FPP_CODE.test(c)) {
    violations.push({
      code: 'FPP_NOT_FOUR_DIGITS',
      message: `"${c}" is not a four-digit code. Annex A codes are four digits, such as 8751.`,
      details: { code: c },
    });
    return { ok: false, violations };
  }
  if (fppSectorOf(c) === null) {
    violations.push({
      code: 'FPP_NO_SECTOR',
      message: `"${c}" begins with ${c[0]}, which is not one of the eight sectors. The GAM uses 1, 3, 4, 5, 6, 7, 8 and 9 - there is no 2000.`,
      details: { code: c },
    });
    return { ok: false, violations };
  }
  if (!BY_CODE.has(c)) {
    violations.push({
      code: 'FPP_NOT_IN_ANNEX_A',
      message: `"${c}" is not in Annex A of the GAM. It will be reported under ${FPP_SECTORS[fppSectorOf(c)!]}; check it is the code the ordinance intends.`,
      details: { code: c, sector: fppSectorOf(c) },
    });
  }
  return { ok: violations.length === 0, violations };
}
