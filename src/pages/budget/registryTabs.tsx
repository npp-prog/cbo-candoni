import { useLocation, useNavigate } from 'react-router-dom';
import { Tabs } from '@/components/ui/Layout';
import { SectionTabs } from '@/components/ui/SectionTabs';
import { BUDGET_MONITORING_TABS } from '@/layout/sections';
import type { RaaoClass } from './raaoReport';

/**
 * Five registries on one menu item.
 *
 * ---------------------------------------------------------------------------
 * WHY TABS AND NOT FIVE MENU ENTRIES
 * ---------------------------------------------------------------------------
 * The GAM prescribes four registries, one per allotment class, and CFMS already
 * had a fifth view - the summary, which is not in the manual but is the one
 * screen that answers "where does this budget line stand" across all four.
 *
 * Five entries in the sidebar, four of them beginning with the same nine
 * words, is precisely the arrangement Neil opened the wrong one of when
 * allotment had two. So: one entry, and the choice made on the screen where
 * the four titles can be read side by side and told apart.
 *
 * The summary is where the menu lands, because it is the one looked at daily.
 * The four statutory registries are printed and filed.
 */

export const REGISTRY_TABS: Array<{ id: string; label: string; to: string }> = [
  { id: 'summary', label: 'Summary', to: '/budget/registry' },
  { id: 'PS', label: 'Personal Services', to: '/budget/registry/ps' },
  { id: 'MOOE', label: 'MOOE', to: '/budget/registry/mooe' },
  { id: 'CO', label: 'Capital Outlay', to: '/budget/registry/co' },
  { id: 'FE', label: 'Financial Expenses', to: '/budget/registry/fe' },
];

/** The route segment each class is reached by. */
export const RAAO_SLUGS: Record<string, RaaoClass> = {
  ps: 'PS',
  mooe: 'MOOE',
  co: 'CO',
  fe: 'FE',
};

export function RegistryTabs({ active }: { active: 'summary' | RaaoClass }) {
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
      <SectionTabs tabs={BUDGET_MONITORING_TABS} />
      <Tabs
        tabs={REGISTRY_TABS.map((t) => ({ id: t.id, label: t.label }))}
        active={active}
        onChange={(id) => {
          const tab = REGISTRY_TABS.find((t) => t.id === id);
          if (tab && tab.to !== pathname) navigate(tab.to);
        }}
      />
    </>
  );
}
