import type { ReactNode } from 'react';
import { Seal } from '@/components/ui/Seal';
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

/**
 * The heading, with the appendix tag in the corner.
 *
 * ---------------------------------------------------------------------------
 * THE LINES COME FROM THE MUNICIPALITY, NOT FROM HERE
 * ---------------------------------------------------------------------------
 * This used to print four lines written out in code - Republic, Province,
 * Municipality of Candoni, and an office. The municipality's own COA forms do
 * not say that. They say Republic / MUNICIPAL GOVERNMENT OF CANDONI / the
 * street address, with no province line and no office line, and every form
 * CFMS printed had the wrong heading on it.
 *
 * `useEntity()` reads them from Settings. Passing them in rather than reading
 * them here keeps this component what it is - furniture, with no opinion about
 * which municipality is using it - and means the printed page cannot show one
 * heading while the exported spreadsheet shows another.
 */
export function Letterhead({
  appendix,
  title,
  lines,
  /** A sub-heading under the title, where the form has one. */
  subtitle,
  /**
   * The municipal seal, centred above "Republic of the Philippines". Patch
   * 117: on the Allotment Release Order and the Augmentation Form.
   */
  seal,
}: {
  appendix?: string;
  title: string;
  lines: string[];
  subtitle?: string;
  /**
   * The municipal seal. `true` or 'center' centres it above the heading (the
   * ARO, the Augmentation Form, the ADA); 'left' puts it at the left of the
   * heading lines (patch 142: the RCI, RADAI and RCDisb), leaving the heading
   * itself centred on the page.
   */
  seal?: boolean | 'center' | 'left';
}) {
  return (
    <div className="relative mb-4 text-center">
      {/* Patch 145: the appendix number is no longer printed on any form. */}
      {/* Patch 145: larger on the RCI / RADAI, beside the heading lines. */}
      {seal === 'left' && <Seal className="absolute left-2 top-0 h-24 w-24" />}
      {seal && seal !== 'left' && <Seal className="mx-auto mb-1.5 h-16 w-16" />}
      {lines.map((line, i) => (
        <p
          key={i}
          className={
            /*
              The entity's own name is the one line printed large. It is the
              second on every COA form, between the Republic and the address.
            */
            i === 1 ? 'text-sm font-bold uppercase tracking-wide' : 'text-2xs'
          }
        >
          {line}
        </p>
      ))}
      <h2 className="mt-3 text-sm font-bold uppercase tracking-wide">{title}</h2>
      {subtitle && <p className="text-2xs">{subtitle}</p>}
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
