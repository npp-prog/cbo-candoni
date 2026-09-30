import { useLocation, useNavigate } from 'react-router-dom';
import { Tabs } from '@/components/ui/Layout';

/**
 * The two faces of allotment, on one menu item.
 *
 * ---------------------------------------------------------------------------
 * WHY THEY ARE TABS AND NOT TWO MENU ITEMS
 * ---------------------------------------------------------------------------
 * They were two menu entries, sitting next to each other and reading almost
 * identically - "Allotment Release Orders" and "Allotments". Neil opened the
 * wrong one, which was the sensible thing to do with two labels that both
 * begin with the same word.
 *
 * Renaming the second to "Allotment Register" helped and did not fix it. The
 * officer still had to decide which of two entries to open BEFORE knowing
 * what was in either, and a decision taken with no information is a decision
 * taken wrong half the time.
 *
 * They are one subject. The register is what you open; the orders are how you
 * add to it. So one menu item, and the strip below is on both screens.
 *
 * ---------------------------------------------------------------------------
 * WHY THE REGISTER IS THE ONE THE MENU LANDS ON
 * ---------------------------------------------------------------------------
 * Allotment is released a handful of times a year, by order. The register is
 * looked at constantly. The menu lands on what is looked at.
 */

export const ALLOTMENT_TABS = [
  { id: 'register', label: 'Register', to: '/budget/allotments' },
  { id: 'orders', label: 'Release Orders', to: '/budget/allotments/orders' },
];

export function AllotmentTabs({ active }: { active: 'register' | 'orders' }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <Tabs
      tabs={ALLOTMENT_TABS.map((t) => ({ id: t.id, label: t.label }))}
      active={active}
      onChange={(id) => {
        const tab = ALLOTMENT_TABS.find((t) => t.id === id);
        if (tab && tab.to !== pathname) navigate(tab.to);
      }}
    />
  );
}
