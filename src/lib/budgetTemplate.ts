/**
 * The CSV the Budget Office fills in for a bulk upload.
 *
 * ---------------------------------------------------------------------------
 * WHY A TEMPLATE AND NOT JUST DOCUMENTATION
 * ---------------------------------------------------------------------------
 * The upload reads column HEADINGS, not column positions, and it accepts
 * several spellings of each - "Account Code", "UACS", "Object Code" all find
 * the same column. That flexibility exists so the annex the office already
 * keeps can be uploaded as it is, and it is worth keeping.
 *
 * But it makes the format invisible. Somebody starting a new file has nothing
 * to copy and guesses at the headings, and a guess that lands outside the
 * accepted spellings produces a file where every row is missing an account
 * code - forty identical errors from one wrong word in row one.
 *
 * So there is a file to start from. Filling in a template beats matching a
 * specification, and the example rows show the two things a written format
 * cannot: what an amount looks like, and what a negative one looks like.
 * ---------------------------------------------------------------------------
 */

export type TemplateKind = 'APPROPRIATION' | 'ALLOTMENT' | 'REALIGNMENT';

export interface TemplateColumn {
  header: string;
  required: boolean;
  /** What the person filling it in needs to know. */
  note: string;
  /** Other headings the upload will also recognise. */
  alsoAccepts?: string[];
}

export const TEMPLATE_COLUMNS: TemplateColumn[] = [
  {
    header: 'Office/Function Name',
    required: true,
    note: 'The office code, the full name or the short name — whichever your annex already uses.',
    alsoAccepts: ['Office/Function Code', 'Office', 'Department', 'Cost Center'],
  },
  {
    header: 'FPP',
    required: true,
    note:
      'The Function, Programme or Project this line is appropriated to. An object code from the ' +
      'Chart of Accounts (5-02-03-010) where the ordinance appropriates by object, or the project ' +
      'name where it appropriates by project.',
    alsoAccepts: ['FPP Code'],
  },
  {
    header: 'FPP Name',
    required: false,
    note: 'The name of the project, or of the object. Taken from the Chart of Accounts if left blank and the FPP is a code.',
  },
  {
    header: 'Sector',
    required: true,
    note:
      'One of the nine in the ordinance. It decides which of the four SRE expenditure buckets ' +
      'this line is reported in.',
  },
  {
    header: 'Service Sector',
    required: false,
    note:
      'REQUIRED on a line whose Sector is a funding source — the 20% Development Fund, the LDRRMF ' +
      'or Others. A road built out of the 20% fund is economic services however it was paid for, ' +
      'and without this the line cannot be placed on the SRE at all.',
    alsoAccepts: ['Sector Served'],
  },
  {
    header: 'Account Code',
    required: false,
    note:
      'Only where the FPP is a project AND the object is already known. Left blank on a project ' +
      'line, which is how the ordinance enacted it: the object becomes known when the obligation ' +
      'is raised. Required on a personnel services line.',
    alsoAccepts: ['UACS', 'Object Code'],
  },
  {
    header: 'Account Name',
    required: false,
    note: 'Ignored if the code is found. Keep it in for whoever reads the file.',
    alsoAccepts: ['Account Title', 'Object of Expenditure'],
  },
  {
    header: 'Allotment Class',
    required: true,
    note:
      'PS, MOOE, FE or CO. Taken from the account where there is one, so it may be left blank on ' +
      'an object-code line — but never on a project line, which has no account to take it from.',
    alsoAccepts: ['Expense Class', 'Class', 'EC'],
  },
  {
    header: 'Annual Appropriation Amount',
    required: true,
    note:
      'Pesos and centavos. Commas and a peso sign are fine. Negative only on a realignment or an ' +
      'adjustment. A "Continuing Appropriations Amount" column beside it is ignored — post ' +
      'continuing appropriations as their own upload.',
    alsoAccepts: ['Amount', 'Appropriation', 'Allotment', 'Budget'],
  },
  {
    header: 'Particulars',
    required: false,
    note: 'Free text carried onto the budget line.',
    alsoAccepts: ['Purpose', 'Description', 'Remarks'],
  },
];

/** A cell that would confuse a spreadsheet, quoted. */
function cell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * The template file.
 *
 * Example rows are included and are meant to be typed over. They are NOT
 * commented out or marked with a word like SAMPLE: a row the office forgets to
 * delete should fail loudly against the Chart of Accounts rather than post
 * quietly, and "OFFICE CODE HERE" does exactly that while still showing the
 * shape. A plausible-looking fake account code would post.
 */
export function budgetTemplateCsv(kind: TemplateKind): string {
  const headers = TEMPLATE_COLUMNS.map((c) => c.header);

  // Office, FPP, FPP Name, Sector, Service Sector, Account Code, Class, Amount, Particulars
  const examples: string[][] =
    kind === 'REALIGNMENT'
      ? [
          // The realignment template shows the shape the rule requires: what is
          // taken, then what is given, coming to zero.
          ['OFFICE NAME HERE', '5-02-01-010', 'Travelling Expenses - Local', 'General Public Services', '', '5-02-01-010', 'MOOE', '-50000.00', 'Realigned to supplies'],
          ['OFFICE NAME HERE', '5-02-03-010', 'Office Supplies Expenses', 'General Public Services', '', '5-02-03-010', 'MOOE', '30000.00', 'From travelling'],
          ['OFFICE NAME HERE', '5-02-03-090', 'Fuel, Oil and Lubricants', 'General Public Services', '', '5-02-03-090', 'MOOE', '20000.00', 'From travelling'],
        ]
      : [
          // An object-code line: the FPP is the account code.
          ['OFFICE NAME HERE', '5-02-03-010', 'Office Supplies Expenses', 'General Public Services', '', '5-02-03-010', 'MOOE', '250000.00', ''],
          // A project line: an FPP with no account code at all.
          ['OFFICE NAME HERE', 'PROJECT NAME HERE', 'Concreting of Barangay Road', 'Economic Services', '', '', 'CO', '1500000.00', ''],
          // A project under a funding source, which must name its service.
          ['OFFICE NAME HERE', 'PROJECT NAME HERE', 'Rehabilitation of Health Centre', '20% Development Fund', 'Health, Nutrition and Population Control', '', 'CO', '2000000.00', ''],
        ];

  return [headers, ...examples].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

/**
 * Hands the template to the browser as a download.
 *
 * A BOM goes first. Without it Excel on a Windows machine set to a Philippine
 * locale reads the file as the legacy code page and mangles any accented
 * character in an office name, and the office would reasonably conclude CFMS
 * had produced a broken file.
 */
export function downloadBudgetTemplate(kind: TemplateKind, fiscalYear: number, fundCode: string): void {
  const name =
    kind === 'ALLOTMENT'
      ? `CFMS-allotment-upload-${fundCode}-${fiscalYear}.csv`
      : kind === 'REALIGNMENT'
        ? `CFMS-realignment-upload-${fundCode}-${fiscalYear}.csv`
        : `CFMS-appropriation-upload-${fundCode}-${fiscalYear}.csv`;

  const blob = new Blob(['﻿' + budgetTemplateCsv(kind)], {
    type: 'text/csv;charset=utf-8;',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
