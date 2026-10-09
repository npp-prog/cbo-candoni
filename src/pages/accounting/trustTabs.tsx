import { useNavigate } from 'react-router-dom';
import { Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { useFilters } from '@/context/FilterContext';
import { TRUST_ACCOUNT_TABS, TRUST_FUND_CODE } from '@/layout/sections';
import type { ReactNode } from 'react';

/**
 * Accounting > Trust Accounts. Patch 136.
 *
 * ---------------------------------------------------------------------------
 * A MENU ITEM OF ITS OWN, FOR THE TRUST FUND ONLY
 * ---------------------------------------------------------------------------
 * Until patch 136 the trust screens were the first tab of Accounting >
 * Monitoring, with three sub-tabs under it. Neil asked for a separate menu,
 * after the Journal Entries Register, holding four screens - and only for the
 * Trust Fund:
 *
 *   FURS                          the Funding Utilization Request and Status,
 *                                 what an Obligation Request is in the Budget
 *   Trust Fund Programmes         what a budget programme is in the Budget
 *   Registry of Special Trust Fund
 *   Fund Utilization Report
 *
 * So there is ONE strip of four now (TRUST_ACCOUNT_TABS in
 * src/layout/sections.ts), drawn by every one of the four screens, and no
 * sub-tabs. The addresses of the three older screens are unchanged.
 */

export const TRUST_TABS = [
  { id: 'furs', label: 'FURS', to: '/accounting/furs' },
  { id: 'programs', label: 'Trust Fund Programmes', to: '/accounting/trust-programs' },
  { id: 'registry', label: 'Registry of Special Trust Fund', to: '/accounting/trust-registry' },
  { id: 'utilization', label: 'Fund Utilization Report', to: '/accounting/fund-utilization' },
];

export type TrustTab = 'furs' | 'programs' | 'registry' | 'utilization';

/** The Trust Accounts strip. `active` is kept for the callers; the strip lights itself. */
export function TrustTabs(_props: { active?: TrustTab }) {
  return <SectionTabs tabs={TRUST_ACCOUNT_TABS} />;
}

/**
 * A Trust Accounts screen, only while the Trust Fund is selected.
 *
 * The menu item is hidden for the General Fund and the Special Education
 * Fund; this covers a bookmark, a typed address, or the fund being changed at
 * the top of the screen while one of these is open.
 */
export function TrustFundOnly({ children }: { children: ReactNode }) {
  const { fundCode, setFundCode } = useFilters();
  const navigate = useNavigate();
  if (String(fundCode).toUpperCase() === TRUST_FUND_CODE) return <>{children}</>;
  return (
    <Alert tone="info" title="Trust Accounts are kept in the Trust Fund">
      <p>
        FURS, Trust Fund Programmes, the Registry of Special Trust Fund and the Fund Utilization
        Report belong to the Trust Fund. The {fundCode} fund has none of them.
      </p>
      <div className="mt-3 flex gap-2">
        <Button variant="primary" size="sm" onClick={() => setFundCode(TRUST_FUND_CODE)}>
          Switch to the Trust Fund
        </Button>
        <Button size="sm" onClick={() => navigate('/accounting/journal-entries')}>
          Back to Accounting
        </Button>
      </div>
    </Alert>
  );
}
