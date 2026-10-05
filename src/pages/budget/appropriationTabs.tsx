import { useLocation, useNavigate } from 'react-router-dom';
import { Tabs } from '@/components/ui/Layout';

/**
 * The appropriation and the programmes it is made to.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PROGRAMMES SIT HERE AND NOT UNDER MASTER DATA
 * ---------------------------------------------------------------------------
 * They were under Master Data, in a two-field screen beside the offices and
 * the banks, which put them with the things that are true all the time.
 *
 * A budget programme is not one of those. It is what the Sanggunian
 * appropriated to in ONE annual budget, it belongs to that year, and it is
 * read and added to while an appropriation is being encoded - not months
 * earlier in a different part of the menu. Keeping the two a tab apart means
 * the officer who finds a programme missing can add it and carry on, rather
 * than leaving the appropriation half-typed to go and find Master Data.
 *
 * Both addresses work and the strip appears on either.
 */

export const APPROPRIATION_TABS = [
  { id: 'appropriations', label: 'Appropriations', to: '/budget/appropriations' },
  { id: 'programmes', label: 'Budget Programmes', to: '/budget/appropriations/programmes' },
];

export type AppropriationTab = 'appropriations' | 'programmes';

export function AppropriationTabs({ active }: { active: AppropriationTab }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <Tabs
      tabs={APPROPRIATION_TABS.map((t) => ({ id: t.id, label: t.label }))}
      active={active}
      onChange={(id) => {
        const tab = APPROPRIATION_TABS.find((t) => t.id === id);
        if (tab && tab.to !== pathname) navigate(tab.to);
      }}
    />
  );
}
