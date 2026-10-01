import { useMemo, useState } from 'react';
import { ReportShell } from '@/components/ReportShell';
import { Alert, Spinner } from '@/components/ui/Layout';
import { Field, Select } from '@/components/ui/Field';
import { useFilters } from '@/context/FilterContext';
import { useAppropriations } from '@/data/queries';
import { formatPeso } from '@/lib/money';
import { formatLongDate } from '@/lib/dates';
import type { ExportColumn } from '@/lib/export';
import {
  LBE_FORM_2_NOTES,
  buildAugmentationForms,
  type AugmentationFormData,
  type AugmentationRow,
} from './augmentationForm';
import { fundLabel } from './Obligations';

/**
 * Augmentation Form - LBE Form No. 2.
 *
 * Budget Operations Manual for LGUs, 2023 edition, page 186. One form per
 * ordinance, laid out as the manual lays it out: savings on the left, the
 * items they augment on the right, and the two totals which must agree.
 *
 * The signature block is the manual's own and not CFMS's usual one - the
 * Accountant signs "Certified Correct by" on this form, which is not the
 * wording ReportShell prints.
 */
export default function AugmentationFormPage() {
  const { fiscalYear, fundCode } = useFilters();
  // "Office: Executive/Sanggunian" is printed on the form as a choice between
  // two. Nothing in the records answers it - it is which branch authorised the
  // use of savings - so it is asked rather than guessed.
  const [office, setOffice] = useState<'Executive' | 'Sanggunian'>('Executive');

  const appropriations = useAppropriations(fiscalYear, fundCode);

  const forms = useMemo(
    () => buildAugmentationForms({ appropriations: appropriations.data }),
    [appropriations.data],
  );

  const exportRows = forms.flatMap((f) => [
    ...f.from.map((r) => ({ form: f, side: 'FROM', r })),
    ...f.to.map((r) => ({ form: f, side: 'TO', r })),
  ]);

  const exportColumns: ExportColumn<(typeof exportRows)[number]>[] = [
    { key: 'ord', header: 'Ordinance No.', value: (x) => x.form.ordinanceNo },
    { key: 'side', header: 'Sources / Uses', value: (x) => x.side },
    { key: 'object', header: 'Object of Expenditures', value: (x) => x.r.objectOfExpenditure },
    { key: 'class', header: 'Expense Class', value: (x) => x.r.expenseClass },
    { key: 'office', header: 'Office', value: (x) => x.r.officeName },
    { key: 'amount', header: 'Amount', kind: 'amount', value: (x) => x.r.amount },
  ];

  const unbalanced = forms.filter((f) => !f.balanced);
  const missingOrdinance = forms.filter((f) => f.ordinanceMissing);

  return (
    <ReportShell
      meta={{
        title: 'Augmentation Form',
        fundLabel: fundLabel(fundCode),
        periodLabel: `FY ${fiscalYear}`,
      }}
      breadcrumbs={[{ label: 'Budget' }, { label: 'Augmentation Form' }]}
      rows={exportRows}
      exportColumns={exportColumns}
      filters={
        <Field label="Office" className="w-56">
          <Select value={office} onChange={(e) => setOffice(e.target.value as typeof office)}>
            <option value="Executive">Executive</option>
            <option value="Sanggunian">Sanggunian</option>
          </Select>
        </Field>
      }
      footnote={
        <>
          <p className="font-medium text-navy-800">Notes</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5">
            {LBE_FORM_2_NOTES.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ol>
          <p className="mt-2">
            LBE Form No. 2, Budget Operations Manual for LGUs (2023 edition), page 186, revised as
            of reprinting for FY 2024. One form per ordinance authorising the use of savings.
          </p>
        </>
      }
    >
      {appropriations.loading ? (
        <Spinner />
      ) : forms.length === 0 ? (
        <Alert tone="info" title="No augmentation recorded">
          No augmentation has been approved for {fiscalYear} in the {fundLabel(fundCode)}. An
          augmentation is recorded under Budget transactions &rarr; Appropriation, by choosing
          Realignment and then &ldquo;Augmentation, under the omnibus authority&rdquo;.
        </Alert>
      ) : (
        <>
          {/*
            The server refuses an unbalanced realignment, so a form that does
            not foot means something reached the records another way. It is
            worth stopping for: the officer is about to sign it.
          */}
          {unbalanced.length > 0 && (
            <Alert tone="error" title="A form does not foot" className="mb-4 no-print">
              The sources and the uses do not come to the same amount on{' '}
              {unbalanced.map((f) => f.ordinanceNo || 'the form with no ordinance').join(', ')}. An
              augmentation neither creates nor destroys authority, so one of the lines is wrong. Do
              not sign it until it is explained.
            </Alert>
          )}

          {missingOrdinance.length > 0 && (
            <Alert tone="warning" title="An augmentation carries no ordinance" className="mb-4 no-print">
              Note 3 of the form: an ordinance is needed unless the General Provisions of the annual
              appropriation ordinance already carry the authority. Lines with no reference recorded
              are gathered on their own form below; enter the ordinance number against them, or the
              General Provisions clause they rest on.
            </Alert>
          )}

          {forms.map((f) => (
            <Form key={f.ordinanceNo || '(none)'} form={f} office={office} fiscalYear={fiscalYear} />
          ))}
        </>
      )}
    </ReportShell>
  );
}

function Form({
  form,
  office,
  fiscalYear,
}: {
  form: AugmentationFormData;
  office: string;
  fiscalYear: number;
}) {
  // The two halves are independent lists, so the table is as long as the
  // longer of them and the shorter side is padded with blanks - exactly as the
  // printed form looks when one side has fewer entries than the other.
  const rows = Math.max(form.from.length, form.to.length);

  return (
    <section className="mb-10 break-inside-avoid">
      <header className="mb-3">
        <p className="text-center text-sm font-bold uppercase tracking-wide text-navy-900">
          Augmentation Form
        </p>
        <p className="text-center text-xs text-navy-700">FY {fiscalYear}</p>
        <div className="mt-3 flex flex-wrap justify-between gap-x-8 gap-y-1 text-xs">
          <span className="text-slate-700">
            Office: <span className="font-medium text-navy-900">{office}</span>
          </span>
          <span className="text-slate-700">
            Ordinance No.:{' '}
            {form.ordinanceMissing ? (
              <span className="text-amber-700">not recorded</span>
            ) : (
              <span className="font-medium text-navy-900">{form.ordinanceNo}</span>
            )}
            {form.authorityDate && (
              <span className="ml-2 text-slate-500">({formatLongDate(form.authorityDate)})</span>
            )}
          </span>
        </div>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full border border-slate-300 text-xs">
          <thead>
            <tr className="border-b border-slate-300 bg-slate-50 text-center text-navy-900">
              <th className="cbo-th border-r border-slate-300 text-center" colSpan={3}>
                Sources of Funds
                <span className="block text-2xs font-normal text-slate-500">FROM</span>
              </th>
              <th className="cbo-th text-center" colSpan={3}>
                Uses of Funds
                <span className="block text-2xs font-normal text-slate-500">TO</span>
              </th>
            </tr>
            <tr className="border-b border-slate-300 text-left text-slate-600">
              <th className="cbo-th">
                Object of Expenditures <span className="text-slate-400">(1)</span>
              </th>
              <th className="cbo-th" style={{ width: '5rem' }}>
                Expense Class <span className="text-slate-400">(2)</span>
              </th>
              <th className="cbo-th border-r border-slate-300 text-right" style={{ width: '9rem' }}>
                Amount <span className="text-slate-400">(3)</span>
              </th>
              <th className="cbo-th">
                Object of Expenditures <span className="text-slate-400">(4)</span>
              </th>
              <th className="cbo-th" style={{ width: '5rem' }}>
                Expense Class <span className="text-slate-400">(5)</span>
              </th>
              <th className="cbo-th text-right" style={{ width: '9rem' }}>
                Amount <span className="text-slate-400">(6)</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, i) => (
              <tr key={i} className="border-b border-slate-100 align-top">
                <Half row={form.from[i]} rule />
                <Half row={form.to[i]} />
              </tr>
            ))}
            <tr className="border-t-2 border-navy-800 font-semibold text-navy-900">
              <td className="cbo-td" colSpan={2}>
                TOTAL
              </td>
              <td className="cbo-td cbo-amount border-r border-slate-300">
                {formatPeso(form.totalFrom)}
              </td>
              <td className="cbo-td" colSpan={2}>
                TOTAL
              </td>
              <td className="cbo-td cbo-amount">{formatPeso(form.totalTo)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {!form.balanced && (
        <p className="mt-1 text-xs text-rose-600">
          The two totals differ by {formatPeso(Math.abs(form.totalFrom - form.totalTo))}.
        </p>
      )}

      {/*
        The manual's own signature block, not ReportShell's. On this form the
        Accountant signs "Certified Correct by", and the approver is the Local
        Chief Executive or the Vice-LCE - wording the standard block does not
        produce.
      */}
      <div className="mt-8 grid gap-8 sm:grid-cols-2">
        <Signature label="Prepared by:" position="Local Budget Officer" />
        <Signature label="Certified Correct by:" position="Local Accountant" />
      </div>
      <div className="mt-6 max-w-sm">
        <Signature label="Approved by:" position="Local Chief Executive (LCE)/Vice-LCE" />
      </div>
    </section>
  );
}

function Half({ row, rule }: { row?: AugmentationRow; rule?: boolean }) {
  const edge = rule ? 'border-r border-slate-300' : '';
  if (!row) {
    return (
      <>
        <td className="cbo-td" />
        <td className="cbo-td" />
        <td className={`cbo-td ${edge}`} />
      </>
    );
  }
  return (
    <>
      <td className="cbo-td">
        {row.objectOfExpenditure}
        <span className="block text-2xs text-slate-500">{row.officeName}</span>
        {row.particulars && (
          <span className="block text-2xs text-slate-400">{row.particulars}</span>
        )}
      </td>
      <td className="cbo-td">{row.expenseClass}</td>
      <td className={`cbo-td cbo-amount ${edge}`}>{formatPeso(row.amount)}</td>
    </>
  );
}

function Signature({ label, position }: { label: string; position: string }) {
  return (
    <div>
      <p className="text-xs text-slate-600">{label}</p>
      <div className="mt-10 border-t border-navy-900 pt-1">
        <p className="text-xs text-navy-900">{position}</p>
      </div>
    </div>
  );
}
