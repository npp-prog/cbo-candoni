import type { ReactNode } from 'react';
import { formatAmount } from '@/lib/money';

/**
 * The furniture of a COA form.
 *
 * Both the collector's Appendix 34 and the Liquidating Officer's version of it
 * are the same sheet of paper with different sections filled in, so the
 * letterhead, the ruled blanks and the signature lines live here rather than
 * being written twice and drifting apart. A form whose heading differs by a
 * line between two screens is the kind of thing nobody notices until an
 * auditor lines the two printouts up.
 */

/** The four-line heading, with the appendix tag in the corner. */
export function Letterhead({
  appendix,
  title,
  office = 'Office of the Municipal Treasurer',
}: {
  appendix?: string;
  title: string;
  office?: string;
}) {
  return (
    <div className="relative mb-4 text-center">
      {appendix && (
        <span className="absolute right-0 top-0 text-2xs italic text-slate-500">{appendix}</span>
      )}
      <p className="text-2xs">Republic of the Philippines</p>
      <p className="text-2xs">Province of Negros Occidental</p>
      <p className="text-sm font-bold uppercase tracking-wide">Municipality of Candoni</p>
      <p className="text-2xs">{office}</p>
      <h2 className="mt-3 text-sm font-bold uppercase tracking-wide">{title}</h2>
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-1.5 mt-4 border-b border-slate-400 pb-0.5 text-2xs font-bold uppercase tracking-wide">
      {children}
    </h3>
  );
}

/**
 * Ruled empty rows.
 *
 * They are not decoration. A section padded to its full height tells a reader
 * that it was considered and found empty; a section that simply stops leaves
 * them wondering whether the rest was cut off.
 */
export function blankRows(count: number, columns: number, keyPrefix: string) {
  return Array.from({ length: Math.max(0, count) }, (_, i) => (
    <tr key={`${keyPrefix}-${i}`}>
      {Array.from({ length: columns }, (_, j) => (
        <td key={j} className="border border-slate-400 px-1.5 py-[7px]">
          &nbsp;
        </td>
      ))}
    </tr>
  ));
}

/** One labelled money line in the Section D summary. */
export function SummaryLine({
  label,
  value,
  indent,
  bold,
  double,
}: {
  label: string;
  value: number;
  indent?: boolean;
  bold?: boolean;
  double?: boolean;
}) {
  return (
    <tr className={bold ? 'font-bold' : undefined}>
      <td className={`border border-slate-400 px-1.5 py-1 ${indent ? 'pl-6' : ''}`}>{label}</td>
      <td
        className={`border border-slate-400 px-1.5 py-1 text-right tabular-nums ${
          double ? 'border-b-4 border-double' : ''
        }`}
        style={{ width: '8rem' }}
      >
        {formatAmount(value, false)}
      </td>
    </tr>
  );
}

/** A signature line: a rule to sign over, with the role beneath it. */
export function SignatureLine({ label, name, role }: { label: string; name?: string; role?: string }) {
  return (
    <div>
      <p className="text-[9px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-8 border-t border-slate-500 pt-1 text-center text-2xs font-semibold">
        {name ?? ' '}
      </p>
      {role && <p className="text-center text-[9px] text-slate-500">{role}</p>}
    </div>
  );
}
