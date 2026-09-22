import { useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Sidebar } from './Sidebar';
import { Header } from './Header';

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-screen bg-slate-50">
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />

      <div className={clsx('transition-all duration-200', collapsed ? 'lg:pl-16' : 'lg:pl-60')}>
        <Header onMenuClick={() => setMobileOpen(true)} sidebarCollapsed={collapsed} />
        <main className="px-4 py-5 sm:px-6 lg:px-8">{children}</main>
        <footer className="px-4 pb-6 pt-2 text-center text-2xs text-slate-400 no-print sm:px-6 lg:px-8">
          CBO - Candoni Books Online &middot; Municipal Government of Candoni, Negros Occidental
        </footer>
      </div>
    </div>
  );
}
