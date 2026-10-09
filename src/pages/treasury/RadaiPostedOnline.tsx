import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { DateInput, Field, TextInput } from '@/components/ui/Field';
import { Alert } from '@/components/ui/Layout';
import { formatPeso } from '@/lib/money';
import { todayPh } from '@/lib/dates';

/** One credit of an advice on the RADAI - a payee and their share. */
export interface RadaiCredit {
  adaId: string;
  adaNo: string;
  lineNo: number;
  payeeName: string;
  accountNumber: string;
  amount: number;
}

/**
 * "Posted online" on the RADAI. Patch 144 (moved here from the ADA, where
 * patch 143 put it: the bank's file is uploaded from the RADAI, for every
 * advice on it at once).
 *
 * Lists every credit of every advice on the report - ATM number, payee,
 * amount - ticked as posted. The Treasury unticks any the bank did not post.
 * Those become trust liabilities: the engine raises ONE draft adjusting entry
 * (Dr Cash in Bank, Cr Trust Liabilities per payee) for the Accountant, and
 * each payee is repaid by a new voucher.
 */
export function RadaiPostedOnlineDialog({
  reportNo,
  credits,
  busy,
  onClose,
  onSubmit,
}: {
  reportNo: string;
  credits: RadaiCredit[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (v: {
    reference: string;
    date: string;
    notPosted: Array<{ adaId: string; lineNo: number }>;
  }) => void;
}) {
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(todayPh());
  const key = (c: RadaiCredit) => `${c.adaId}#${c.lineNo}`;
  const [off, setOff] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const total = credits.reduce((t, c) => t + c.amount, 0);
  const notPostedAmount = credits.filter((c) => off.has(key(c))).reduce((t, c) => t + c.amount, 0);

  return (
    <Modal
      open
      onClose={onClose}
      title={`RADAI ${reportNo} - posted online`}
      description={`${credits.length} credit${credits.length === 1 ? '' : 's'}, ${formatPeso(total)}. Untick any credit the bank did NOT post.`}
      size="xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() =>
              onSubmit({
                reference: reference.trim(),
                date,
                notPosted: credits
                  .filter((c) => off.has(key(c)))
                  .map((c) => ({ adaId: c.adaId, lineNo: c.lineNo })),
              })
            }
          >
            {off.size > 0 ? 'Record posting and trust liabilities' : 'Record posting'}
          </Button>
        </>
      }
    >
      <div className="max-h-[50vh] overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-600">
            <tr>
              <th className="w-16 px-2 py-1.5 font-medium">Posted</th>
              <th className="px-2 py-1.5 font-medium">ADA No.</th>
              <th className="px-2 py-1.5 font-medium">ATM / account no.</th>
              <th className="px-2 py-1.5 font-medium">Payee</th>
              <th className="px-2 py-1.5 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {credits.map((c) => {
              const k = key(c);
              const notPosted = off.has(k);
              return (
                <tr key={k} className={notPosted ? 'bg-amber-50' : undefined}>
                  <td className="px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={!notPosted}
                      onChange={() => toggle(k)}
                      aria-label={`Posted to ${c.payeeName}`}
                    />
                  </td>
                  <td className="px-2 py-1.5 font-mono text-xs">{c.adaNo}</td>
                  <td className="px-2 py-1.5 font-mono text-xs">{c.accountNumber || '-'}</td>
                  <td className="px-2 py-1.5">
                    {c.payeeName}
                    {notPosted && (
                      <span className="ml-2 text-2xs font-semibold text-amber-800">
                        NOT POSTED - trust liability
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono">
                    {formatPeso(c.amount, { symbol: false })}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t-2 border-navy-800 text-sm font-semibold">
            <tr>
              <td className="px-2 py-1.5" colSpan={4}>
                Posted
              </td>
              <td className="px-2 py-1.5 text-right font-mono">
                {formatPeso(total - notPostedAmount, { symbol: false })}
              </td>
            </tr>
            {notPostedAmount > 0 && (
              <tr className="text-amber-800">
                <td className="px-2 py-1.5" colSpan={4}>
                  Not posted - to Trust Liabilities
                </td>
                <td className="px-2 py-1.5 text-right font-mono">
                  {formatPeso(notPostedAmount, { symbol: false })}
                </td>
              </tr>
            )}
          </tfoot>
        </table>
      </div>

      {notPostedAmount > 0 && (
        <Alert tone="warning" className="mt-3" title="What happens to the credits not posted">
          One adjusting entry is prepared for the Accountant - Dr Cash in Bank, Cr Trust
          Liabilities for each payee not posted - and waits in General Transactions to be posted.
          Each payee is then repaid by a new disbursement voucher of the &quot;Trust
          liability&quot; kind.
        </Alert>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Date posted online" required htmlFor="radaiPostedDate">
          <DateInput id="radaiPostedDate" value={date} onChange={setDate} />
        </Field>
        <Field
          label="Bank reference number"
          htmlFor="radaiBankRef"
          hint="The reference of the bank's online posting. Reconciliation matches on this."
        >
          <TextInput
            id="radaiBankRef"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            className="font-mono"
          />
        </Field>
      </div>
    </Modal>
  );
}
