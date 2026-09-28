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
    header: 'Office',
    required: true,
    note: 'The office code, the full name or the short name — whichever your annex already uses.',
    alsoAccepts: ['Department', 'Dept', 'Cost Center'],
  },
  {
    header: 'Account Code',
    required: true,
    note: 'Must exist in the Chart of Accounts and must be a postable account, not a heading.',
    alsoAccepts: ['UACS', 'Code', 'Object Code'],
  },
  {
    header: 'Account Name',
    required: false,
    note: 'Ignored if the code is found. Keep it in for whoever reads the file.',
    alsoAccepts: ['Account Title', 'Object of Expenditure'],
  },
  {
    header: 'Expense Class',
    required: false,
    note: 'PS, MOOE, FE or CO. Left blank, the class on the account is used.',
    alsoAccepts: ['Allotment Class', 'Class', 'EC'],
  },
  {
    header: 'Amount',
    required: true,
    note: 'Pesos and centavos. Commas and a peso sign are fine. Negative only on a realignment or an adjustment.',
    alsoAccepts: ['Appropriation', 'Allotment', 'Budget', 'Total'],
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

  const examples: string[][] =
    kind === 'REALIGNMENT'
      ? [
          // The template for a realignment shows the shape the rule requires:
          // what is taken, then what is given, coming to zero.
          ['OFFICE CODE HERE', 'ACCOUNT CODE HERE', 'Travelling Expenses', 'MOOE', '-50000.00', 'Realigned to supplies'],
          ['OFFICE CODE HERE', 'ACCOUNT CODE HERE', 'Office Supplies Expenses', 'MOOE', '30000.00', 'From travelling'],
          ['OFFICE CODE HERE', 'ACCOUNT CODE HERE', 'Fuel, Oil and Lubricants', 'MOOE', '20000.00', 'From travelling'],
        ]
      : [
          ['OFFICE CODE HERE', 'ACCOUNT CODE HERE', 'Office Supplies Expenses', 'MOOE', '250000.00', ''],
          ['OFFICE CODE HERE', 'ACCOUNT CODE HERE', 'Travelling Expenses - Local', 'MOOE', '120000.00', ''],
        ];

  return [headers, ...examples].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

/**
 * Hands the template to the browser as a download.
 *
 * A BOM goes first. Without it Excel on a Windows machine set to a Philippine
 * locale reads the file as the legacy code page and mangles any accented
 * character in an office name, and the office would reasonably conclude CBO
 * had produced a broken file.
 */
export function downloadBudgetTemplate(kind: TemplateKind, fiscalYear: number, fundCode: string): void {
  const name =
    kind === 'ALLOTMENT'
      ? `CBO-allotment-upload-${fundCode}-${fiscalYear}.csv`
      : kind === 'REALIGNMENT'
        ? `CBO-realignment-upload-${fundCode}-${fiscalYear}.csv`
        : `CBO-appropriation-upload-${fundCode}-${fiscalYear}.csv`;

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
