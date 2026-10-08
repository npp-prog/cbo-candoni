import { useLocation, useNavigate } from 'react-router-dom';
import { Tabs } from '@/components/ui/Layout';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { ACCOUNTING_MONITORING_TABS } from '@/layout/sections';

/**
 * The Trust Fund's three screens, on one menu item.
 *
 * ---------------------------------------------------------------------------
 * WHY THEY ARE TABS AND NOT THREE ENTRIES
 * ---------------------------------------------------------------------------
 * They were three, sitting in a row under Monitoring and Setup, and they are
 * one subject seen three ways: the programmes are what the municipality agreed
 * to hold money for, the registry is what has been committed against them, and
 * the utilization report is what the source of the money is told.
 *
 * Three entries made the officer pick one before knowing what was in any of
 * them, and they pushed the rest of Monitoring and Setup down the menu - so
 * the Trust Fund, which is the smallest of the three funds, took the most
 * room in the list.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PROGRAMMES ARE FIRST
 * ---------------------------------------------------------------------------
 * Nothing else here means anything until a programme exists: the registry is
 * kept per programme and the report is drawn per programme. The menu lands on
 * the one the others depend on.
 *
 * The three addresses are unchanged, so an old bookmark still works and the
 * strip appears whichever one it lands on.
 */

export const TRUST_TABS = [
  { id: 'programs', label: 'Trust Fund Programmes', to: '/accounting/trust-programs' },
  { id: 'registry', label: 'Registry of Special Trust Fund', to: '/accounting/trust-registry' },
  { id: 'utilization', label: 'Fund Utilization Report', to: '/accounting/fund-utilization' },
];

export type TrustTab = 'programs' | 'registry' | 'utilization';

export function TrustTabs({ active }: { active: TrustTab }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  /*
    THE MAIN TABS COME WITH THE SUB-TABS, ALWAYS.

    Each screen used to draw the strip above it for itself, and only the first
    one did - so the moment the officer moved to the second sub-tab the main
    tabs vanished, and with them the only way across to the next main tab
    without going back to the menu. Drawing both here means a screen cannot
    show these sub-tabs without the strip they sit under. Patch 111.
  */
  return (
    <>
      <SectionTabs tabs={ACCOUNTING_MONITORING_TABS} />
      <Tabs
        tabs={TRUST_TABS.map((t) => ({ id: t.id, label: t.label }))}
        active={active}
        onChange={(id) => {
          const tab = TRUST_TABS.find((t) => t.id === id);
          if (tab && tab.to !== pathname) navigate(tab.to);
        }}
      />
    </>
  );
}
