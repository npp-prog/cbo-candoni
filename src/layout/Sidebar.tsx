import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import clsx from 'clsx';
import { NAVIGATION, ICONS } from './navigation';
import { useAuth } from '@/auth/AuthProvider';

/**
 * The navy rail.
 *
 * Collapsible, because on a 1366x768 municipal workstation - still the common
 * screen here - a 15rem sidebar is a meaningful share of the width when a user
 * is working through a wide registry.
 *
 * Sections the signed-in user has no permission to view are not rendered at
 * all. Rendering them disabled would only invite requests for access to
 * screens that person's role is deliberately kept away from.
 */
export function Sidebar({
  collapsed,
  onToggle,
  mobileOpen,
  onMobileClose,
}: {
  collapsed: boolean;
  onToggle: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
}) {
  const { can } = useAuth();
  const location = useLocation();
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());

  // Keep the section containing the current route open.
  useEffect(() => {
    const match = NAVIGATION.find(
      (item) => item.children && location.pathname.startsWith(item.to) && item.to !== '/',
    );
    if (match) {
      setOpenSections((s) => new Set(s).add(match.to));
    }
  }, [location.pathname]);

  const visible = NAVIGATION.filter((item) => can(item.module, 'view'));

  return (
    <>
      {/* Backdrop for the mobile drawer. */}
      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-navy-950/50 lg:hidden no-print" onClick={onMobileClose} aria-hidden="true" />
      )}

      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-40 flex flex-col bg-navy-900 text-slate-300 transition-all duration-200 no-print',
          'lg:translate-x-0',
          collapsed ? 'w-16' : 'w-60',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {/* Wordmark */}
        <div className={clsx('flex items-center gap-2.5 border-b border-navy-800 px-4 py-4', collapsed && 'justify-center px-2')}>
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-brand-600 text-sm font-bold text-white">
            CBO
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-white">Candoni Books Online</p>
              <p className="truncate text-2xs text-slate-400">Municipal Government of Candoni</p>
            </div>
          )}
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label="Main">
          <ul className="space-y-0.5">
            {visible.map((item) => {
              const isOpen = openSections.has(item.to);
              const isActive =
                item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to);

              return (
                <li key={item.to}>
                  {item.children ? (
                    <>
                      <button
                        onClick={() => {
                          if (collapsed) {
                            onToggle();
                            setOpenSections((s) => new Set(s).add(item.to));
                            return;
                          }
                          setOpenSections((s) => {
                            const next = new Set(s);
                            if (next.has(item.to)) next.delete(item.to);
                            else next.add(item.to);
                            return next;
                          });
                        }}
                        className={clsx(
                          'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
                          isActive ? 'bg-navy-800 text-white' : 'hover:bg-navy-800/60 hover:text-white',
                          collapsed && 'justify-center px-2',
                        )}
                        title={collapsed ? item.label : undefined}
                        aria-expanded={isOpen}
                      >
                        <NavIcon name={item.icon} />
                        {!collapsed && (
                          <>
                            <span className="flex-1 text-left truncate">{item.label}</span>
                            <svg
                              className={clsx('h-3.5 w-3.5 shrink-0 transition-transform', isOpen && 'rotate-90')}
                              viewBox="0 0 20 20"
                              fill="currentColor"
                              aria-hidden="true"
                            >
                              <path
                                fillRule="evenodd"
                                d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                                clipRule="evenodd"
                              />
                            </svg>
                          </>
                        )}
                      </button>

                      {!collapsed && isOpen && (
                        <ul className="mb-1 mt-0.5 space-y-0.5 border-l border-navy-800 pl-3 ml-4">
                          {item.children.map((child, index) => (
                            <li key={child.to}>
                              {/* A group heading appears once, above the first
                                  child that carries it. */}
                              {child.group && child.group !== item.children?.[index - 1]?.group && (
                                <div className="mt-2.5 px-2.5 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 first:mt-0">
                                  {child.group}
                                </div>
                              )}
                              <NavLink
                                to={child.to}
                                onClick={onMobileClose}
                                className={({ isActive: active }) =>
                                  clsx(
                                    'block rounded px-2.5 py-1.5 text-xs transition-colors',
                                    active
                                      ? 'bg-brand-600/20 text-white font-medium'
                                      : 'text-slate-400 hover:bg-navy-800/60 hover:text-white',
                                  )
                                }
                              >
                                {child.label}
                              </NavLink>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : (
                    <NavLink
                      to={item.to}
                      end={item.to === '/'}
                      onClick={onMobileClose}
                      className={({ isActive: active }) =>
                        clsx(
                          'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
                          active ? 'bg-brand-600 text-white' : 'hover:bg-navy-800/60 hover:text-white',
                          collapsed && 'justify-center px-2',
                        )
                      }
                      title={collapsed ? item.label : undefined}
                    >
                      <NavIcon name={item.icon} />
                      {!collapsed && <span className="truncate">{item.label}</span>}
                    </NavLink>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>

        <button
          onClick={onToggle}
          className="hidden items-center justify-center gap-2 border-t border-navy-800 px-3 py-2.5 text-xs text-slate-400 hover:bg-navy-800 hover:text-white lg:flex"
        >
          <svg
            className={clsx('h-4 w-4 transition-transform', collapsed && 'rotate-180')}
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M12.79 5.23a.75.75 0 01-.02 1.06L8.832 10l3.938 3.71a.75.75 0 11-1.04 1.08l-4.5-4.25a.75.75 0 010-1.08l4.5-4.25a.75.75 0 011.06.02z"
              clipRule="evenodd"
            />
          </svg>
          {!collapsed && 'Collapse'}
        </button>
      </aside>
    </>
  );
}

function NavIcon({ name }: { name: string }) {
  return (
    <svg
      className="h-4.5 w-4.5 shrink-0"
      style={{ width: '1.125rem', height: '1.125rem' }}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d={ICONS[name] ?? ICONS.dashboard} />
    </svg>
  );
}
