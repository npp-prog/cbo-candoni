import { SubsidiaryPicker } from './index';
import { collectionLineNeedsSubsidiary } from '@/lib/collectionSubsidiary';

/**
 * Patch 158: under the account of a receipt line, the subsidiary ledger
 * account - shown only where the account needs one (a receivable, a payable,
 * or a revenue account the chart says is kept per party).
 */
export function LineSubsidiary({
  accountCode,
  account,
  value,
  onChange,
  fundCode,
}: {
  accountCode: string | null | undefined;
  account: { requiresSubsidiary?: boolean | null } | null | undefined;
  value: { subsidiaryType?: string | null; subsidiaryId?: string | null };
  onChange: (sub: {
    subsidiaryType: string | null;
    subsidiaryId: string | null;
    subsidiaryName: string | null;
  }) => void;
  fundCode?: string;
}) {
  if (!collectionLineNeedsSubsidiary(accountCode, account)) return null;
  const missing = !value.subsidiaryId;
  return (
    <div className="mt-1.5">
      <p className={`mb-0.5 text-2xs ${missing ? 'text-rose-700' : 'text-slate-500'}`}>
        Subsidiary ledger account (required)
      </p>
      <SubsidiaryPicker
        fundCode={fundCode}
        value={
          value.subsidiaryId && value.subsidiaryType
            ? `${value.subsidiaryType}:${value.subsidiaryId}`
            : null
        }
        onChange={(chosen) =>
          onChange({
            subsidiaryType: chosen?.type ?? null,
            subsidiaryId: chosen?.id ?? null,
            subsidiaryName: chosen?.name ?? null,
          })
        }
      />
    </div>
  );
}
