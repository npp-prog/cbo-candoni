import { useMemo, useState } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { PageHeader, Card, Alert, Spinner } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, TextInput, TextArea } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/auth/AuthProvider';
import { useDocument } from '@/hooks/useFirestore';
import { useFilters } from '@/context/FilterContext';
import { db } from '@/lib/firebase';
import { COL } from '@/lib/collections';
import { todayPh, formatShortDate } from '@/lib/dates';
import {
  augmentationAuthorityKey,
  type AugmentationAuthority as Authority,
  type AugmentationAuthorityEntry,
} from '@/lib/accounting-rules';
import { fundLabel } from './Obligations';

/**
 * Recording that the appropriation ordinance allows augmentation.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SCREEN AND NOT A TICK-BOX ON THE FORM
 * ---------------------------------------------------------------------------
 * Section 336 lets the Local Chief Executive augment an item from savings in
 * other items - but only where the annual budget's General Provisions carry
 * the omnibus authority. Without it, moving appropriation needs a supplemental
 * budget like any other transfer.
 *
 * That is a fact about one ordinance, settled once a year, and it is read off
 * a document. Asking the question again on every augmentation would put it in
 * front of the person least able to answer it and most likely to click past
 * it; asking it nowhere would have CBO assume an authority it has never seen.
 *
 * So it is recorded once for each fiscal year and fund, with the ordinance
 * number and the section that grants it, and `importBudgetLines` refuses an
 * augmentation until it has been.
 *
 * ---------------------------------------------------------------------------
 * AND NOT BY THE BUDGET OFFICE
 * ---------------------------------------------------------------------------
 * The Budget Officer may write every other budget setting in CBO and is kept
 * off this one. They are the office that posts augmentations, and a gate the
 * person passing through can open for themselves is not a gate. Reading the
 * ordinance and recording what it says is the Accountant's kind of work.
 */
export default function AugmentationAuthority() {
  const { fiscalYear, fundCode } = useFilters();
  const { hasRole, user, profile } = useAuth();
  const toast = useToast();

  const stored = useDocument<{ entries?: Authority }>(COL.settings, 'augmentationAuthority');
  const key = augmentationAuthorityKey(fiscalYear, fundCode);
  const entry = stored.data?.entries?.[key];

  const canRecord = hasRole('SUPER_ADMIN', 'MUNICIPAL_ACCOUNTANT');

  const [ordinanceNo, setOrdinanceNo] = useState('');
  const [section, setSection] = useState('');
  const [remarks, setRemarks] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);

  const open = editing || !entry;

  const ready = ordinanceNo.trim().length > 0 && section.trim().length > 0;

  /** Every year and fund already recorded, newest first. */
  const recorded = useMemo(() => {
    const entries = stored.data?.entries ?? {};
    return Object.entries(entries)
      .map(([k, v]) => {
        const [year, fund] = k.split('__');
        return { key: k, year: Number(year), fund, ...v };
      })
      .sort((a, b) => b.year - a.year || a.fund.localeCompare(b.fund));
  }, [stored.data]);

  const record = async () => {
    setSaving(true);
    try {
      const value: AugmentationAuthorityEntry = {
        ordinanceNo: ordinanceNo.trim(),
        generalProvisionsSection: section.trim(),
        remarks: remarks.trim() || undefined,
        recordedBy: {
          uid: user?.uid ?? '',
          name: profile?.displayName ?? user?.email ?? user?.uid ?? '',
          at: new Date().toISOString(),
        },
      };
      /*
       * Merged, not replaced. Every fiscal year and fund lives in one document,
       * and writing it whole would delete the years somebody recorded before.
       */
      await setDoc(
        doc(db, COL.settings, 'augmentationAuthority'),
        { entries: { [key]: value } },
        { merge: true },
      );
      toast.success(
        'Authority recorded',
        `Augmentation is now allowed in the ${fundLabel(fundCode)} for ${fiscalYear}.`,
      );
      setEditing(false);
      setOrdinanceNo('');
      setSection('');
      setRemarks('');
    } catch (err) {
      toast.error('Nothing was saved', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Augmentation Authority"
        subtitle={`${fundLabel(fundCode)} - ${fiscalYear}`}
        breadcrumbs={[{ label: 'Budget', to: '/budget' }, { label: 'Augmentation Authority' }]}
      />

      <Card className="mb-4">
        <p className="text-sm text-navy-800">
          Section 336 of the Local Government Code lets the Local Chief Executive augment an item
          from savings in other items of the same expense class &mdash; but only where the annual
          budget&rsquo;s General Provisions carry the omnibus authority to do so. Where they do
          not, the same movement needs a supplemental budget by ordinance.
        </p>
        <p className="mt-2 text-sm text-navy-800">
          CBO cannot read an ordinance and will not assume one. Until the authority is recorded
          here for a fiscal year and fund, an augmentation in that year does not post &mdash; the
          Budget Office is told why, and pointed at this page.
        </p>
      </Card>

      {stored.loading ? (
        <Spinner label="Reading what has been recorded" />
      ) : (
        <>
          {entry && !editing && (
            <Alert tone="success" title={`Augmentation is authorised for ${fiscalYear}`} className="mb-4">
              <p>
                Ordinance {entry.ordinanceNo}, {entry.generalProvisionsSection}.
              </p>
              {entry.remarks && <p className="mt-1">{entry.remarks}</p>}
              {entry.recordedBy?.name && (
                <p className="mt-1 text-xs">
                  Recorded by {entry.recordedBy.name} on{' '}
                  {formatShortDate(entry.recordedBy.at.slice(0, 10))}.
                </p>
              )}
              {canRecord && (
                <Button size="sm" className="mt-2" onClick={() => setEditing(true)}>
                  Correct this
                </Button>
              )}
            </Alert>
          )}

          {!entry && (
            <Alert
              tone="warning"
              title={`Nothing recorded for ${fiscalYear}`}
              className="mb-4"
            >
              No augmentation can be posted in the {fundLabel(fundCode)} for {fiscalYear} until the
              ordinance and the section granting the authority are recorded below.
            </Alert>
          )}

          {open && !canRecord && (
            <Alert tone="info" className="mb-4">
              Only the Municipal Accountant or an administrator records this. That is deliberate:
              the Budget Office posts augmentations, and the authority for them should not be
              something that office grants itself. Ask the Accountant to read the General
              Provisions of the {fiscalYear} appropriation ordinance and record what they say.
            </Alert>
          )}

          {open && canRecord && (
            <Card className="mb-4">
              <h3 className="mb-3 text-sm font-semibold text-navy-900">
                Record the authority for {fiscalYear}, {fundLabel(fundCode)}
              </h3>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Appropriation ordinance"
                  required
                  hint="The annual budget ordinance whose General Provisions grant the authority."
                >
                  <TextInput
                    value={ordinanceNo}
                    onChange={(e) => setOrdinanceNo(e.target.value)}
                    placeholder={`No. ____, series of ${fiscalYear}`}
                  />
                </Field>

                <Field
                  label="Section of the General Provisions"
                  required
                  hint="Which section says the Local Chief Executive may augment."
                >
                  <TextInput
                    value={section}
                    onChange={(e) => setSection(e.target.value)}
                    placeholder="Section ___"
                  />
                </Field>
              </div>

              <Field
                label="Remarks"
                className="mt-4"
                hint="Anything the section qualifies - a ceiling, a reporting requirement."
              >
                <TextArea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
              </Field>

              <div className="mt-4 flex items-center gap-2">
                <Button variant="primary" loading={saving} disabled={!ready} onClick={() => void record()}>
                  Record the authority
                </Button>
                {editing && (
                  <Button onClick={() => setEditing(false)}>Cancel</Button>
                )}
                <span className="text-xs text-slate-500">
                  Recorded as at {formatShortDate(todayPh())}.
                </span>
              </div>
            </Card>
          )}

          {recorded.length > 0 && (
            <Card>
              <h3 className="mb-3 text-sm font-semibold text-navy-900">What has been recorded</h3>
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className="cbo-th">Year</th>
                    <th className="cbo-th">Fund</th>
                    <th className="cbo-th">Ordinance</th>
                    <th className="cbo-th">General Provisions</th>
                    <th className="cbo-th">Recorded by</th>
                  </tr>
                </thead>
                <tbody>
                  {recorded.map((r) => (
                    <tr key={r.key}>
                      <td className="cbo-td">{r.year}</td>
                      <td className="cbo-td">{fundLabel(r.fund)}</td>
                      <td className="cbo-td">{r.ordinanceNo}</td>
                      <td className="cbo-td">{r.generalProvisionsSection}</td>
                      <td className="cbo-td text-xs text-slate-500">
                        {r.recordedBy?.name ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-slate-500">
                A year with no row here is a year in which no augmentation can be posted. That is
                not an oversight to be worked around &mdash; it means nobody has yet read the
                ordinance and said that it grants the power.
              </p>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
