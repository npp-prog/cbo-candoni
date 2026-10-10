import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { usePayees, useTaxCodes } from '@/data/queries';
import { useEntity } from '@/data/useEntity';
import { form2307FromVoucher } from '@/lib/bir2307';
import { withoutEtAl } from '@/lib/accounting-rules';
import type { DisbursementVoucher } from '@/types/accounting';

/**
 * Patch 162: "BIR 2307" on a voucher that withholds tax - the Certificate of
 * Creditable Tax Withheld at Source, on the BIR's own Excel form, for the
 * quarter of the voucher's date. See src/lib/bir2307.ts.
 */
export function Bir2307Button({ dv }: { dv: DisbursementVoucher }) {
  const toast = useToast();
  const taxCodes = useTaxCodes();
  const payees = usePayees();
  const entity = useEntity();
  const [busy, setBusy] = useState(false);

  const payee = payees.data.find((p) => p.id === dv.payeeId);
  const form = form2307FromVoucher({
    date: dv.dvDate,
    deductions: (dv.deductions ?? []).map((d) => ({
      taxCodeId: d.taxCodeId ?? null,
      code: d.code,
      description: d.description,
      // The base the rate was applied to; the gross where an old voucher kept none.
      base: d.base || dv.grossAmount,
      amount: d.amount,
    })),
    taxCodes: taxCodes.data,
    payee: {
      tin: payee?.tin ?? '',
      name: withoutEtAl(dv.payeeName),
      address: payee?.address ?? '',
      zip: payee?.zipCode ?? '',
    },
    payor: {
      tin: entity.tin ?? '',
      name: entity.headingLines[1] ?? '',
      address: entity.headingLines[2] ?? '',
      zip: entity.zipCode ?? '',
    },
    signatory: entity.localTreasurer,
  });
  if (!form) return null;

  return (
    <Button
      loading={busy}
      title="BIR Form 2307 - Certificate of Creditable Tax Withheld at Source, as an Excel file"
      onClick={() => {
        setBusy(true);
        void import('@/lib/bir2307Xlsx')
          .then(({ download2307 }) =>
            download2307(form, `BIR 2307_${dv.dvNo}_${withoutEtAl(dv.payeeName)}.xlsx`),
          )
          .then(() => {
            if (!payee?.tin || !entity.tin) {
              toast.success(
                'BIR 2307 downloaded',
                !entity.tin
                  ? "The municipality's TIN is not in Settings yet - fill it in (Administration > Settings) so it prints in Part II."
                  : "The payee's TIN is not on Names - fill it in so it prints in Part I.",
              );
            }
          })
          .catch((err) =>
            toast.error(
              'Could not make the 2307',
              err instanceof Error ? err.message : String(err),
            ),
          )
          .finally(() => setBusy(false));
      }}
    >
      BIR 2307
    </Button>
  );
}
