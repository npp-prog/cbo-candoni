import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { useAuth } from '@/auth/AuthProvider';
import { useFilters } from '@/context/FilterContext';
import { useFiscalYearRecords, useFunds, useNotifications } from '@/data/queries';
import { fiscalYearList, nearestFiscalYear } from '@/lib/fiscalYears';
import { ENVIRONMENT, IS_PRODUCTION } from '@/lib/firebase';
import { monthName, todayPh } from '@/lib/dates';
import { ROLE_LABELS, type Role } from '@/types/system';
import { UniversalSearch } from '@/components/UniversalSearch';

/**
 * The header carries the three things a user must always be able to see: which
 * municipality and system they are in, which fiscal year and fund they are
 * working in, and who they are signed in as.
 *
 * The fund selector is not tucked into a settings page because posting to the
 * wrong fund is a real and expensive mistake. It is visible on every screen,
 * and on a non-production deployment the environment banner is unmissable -
 * a developer testing a year-end close against live municipal data would be
 * far worse than an ugly stripe.
 */
export function Header({
  onMenuClick,
  sidebarCollapsed,
}: {
  onMenuClick: () => void;
  sidebarCollapsed: boolean;
}) {
  const { profile, roles, signOut, user } = useAuth();
  const { fiscalYear, setFiscalYear, fundCode, setFundCode, period, setPeriod } = useFilters();
  const { data: funds } = useFunds();
  const { data: notifications } = useNotifications(user?.uid ?? null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const navigate = useNavigate();

  /*
   * Patch 171: 2026 (the comparative year) and 2027 (the first year of
   * CFMS), and every year the administrator has added since - not years
   * counted back from the calendar.
   */
  const fyRecords = useFiscalYearRecords();
  const years = useMemo(
    () => fiscalYearList(fyRecords.data.map((r) => Number(r.year ?? r.id))),
    [fyRecords.data],
  );
  useEffect(() => {
    if (fyRecords.loading || years.includes(fiscalYear)) return;
    setFiscalYear(nearestFiscalYear(years, Number(todayPh().slice(0, 4))));
  }, [fyRecords.loading, years, fiscalYear, setFiscalYear]);

  return (
    <>
      {!IS_PRODUCTION && (
        <div className="bg-amber-500 px-4 py-1 text-center text-2xs font-semibold uppercase tracking-wider text-amber-950 no-print">
          {ENVIRONMENT} environment - this is not live municipal data
        </div>
      )}

      <header
        className={clsx(
          'app-header sticky top-0 z-20 border-b border-slate-200 bg-white no-print',
          'transition-all duration-200',
        )}
      >
        <div className="flex h-14 items-center gap-3 px-4">
          <button
            onClick={onMenuClick}
            className="rounded p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden"
            aria-label="Open navigation"
          >
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path
                fillRule="evenodd"
                d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zm0 5A.75.75 0 012.75 9h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 9.75zm0 5a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z"
                clipRule="evenodd"
              />
            </svg>
          </button>

          {/*
            Patch 152: the municipality's name is gone from here - it is on
            the sidebar and on every printed form - and the search takes its
            place, as wide as the bar allows.
          */}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="min-w-0 max-w-2xl flex-1">
              <UniversalSearch />
            </div>

            {/* Working context: fiscal year, fund and period. */}
            <div className="ml-auto hidden items-center gap-1.5 rounded-md border border-slate-300 bg-slate-50 px-1.5 py-1 sm:flex">
              <select
                value={fiscalYear}
                onChange={(e) => setFiscalYear(Number(e.target.value))}
                className="border-0 bg-transparent py-0.5 pl-1 pr-6 text-xs font-medium text-navy-900 focus:ring-0"
                aria-label="Fiscal year"
              >
                {years.map((y) => (
                  <option key={y} value={y}>
                    FY {y}
                  </option>
                ))}
              </select>

              <span className="text-slate-300">|</span>

              <select
                value={fundCode}
                onChange={(e) => setFundCode(e.target.value)}
                className="border-0 bg-transparent py-0.5 pl-1 pr-6 text-xs font-medium text-navy-900 focus:ring-0"
                aria-label="Fund"
              >
                {(funds.length
                  ? funds
                  : [
                      { id: 'GF', code: 'GF', name: 'General Fund' },
                      { id: 'SEF', code: 'SEF', name: 'Special Education Fund' },
                      { id: 'TF', code: 'TF', name: 'Trust Fund' },
                    ]
                ).map((f) => (
                  <option key={f.code} value={f.code}>
                    {f.code}
                  </option>
                ))}
              </select>

              <span className="text-slate-300">|</span>

              <select
                value={period ?? ''}
                onChange={(e) => setPeriod(e.target.value === '' ? null : Number(e.target.value))}
                className="border-0 bg-transparent py-0.5 pl-1 pr-6 text-xs font-medium text-navy-900 focus:ring-0"
                aria-label="Accounting period"
              >
                <option value="">All months</option>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={m}>
                    {monthName(m)}
                  </option>
                ))}
              </select>
            </div>

            <button
              onClick={() => navigate('/notifications')}
              className="relative rounded p-1.5 text-slate-500 hover:bg-slate-100"
              aria-label={`Notifications${notifications.length ? `, ${notifications.length} unread` : ''}`}
            >
              <svg
                className="h-5 w-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"
                />
              </svg>
              {notifications.length > 0 && (
                <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-2xs font-semibold text-white">
                  {notifications.length > 9 ? '9+' : notifications.length}
                </span>
              )}
            </button>

            <div className="relative">
              <button
                onClick={() => setUserMenuOpen((s) => !s)}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-slate-100"
              >
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-navy-700 text-2xs font-semibold text-white">
                  {initials(profile?.displayName ?? user?.email ?? '?')}
                </div>
                <div className="hidden text-left lg:block">
                  <p className="max-w-[10rem] truncate text-xs font-medium text-navy-900">
                    {profile?.displayName ?? user?.email}
                  </p>
                  <p className="max-w-[10rem] truncate text-2xs text-slate-500">
                    {roles.length ? ROLE_LABELS[roles[0] as Role] : 'No role assigned'}
                  </p>
                </div>
              </button>

              {userMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setUserMenuOpen(false)} />
                  <div className="absolute right-0 z-20 mt-1 w-64 rounded-md border border-slate-200 bg-white py-1 shadow-raised">
                    <div className="border-b border-slate-100 px-3 py-2.5">
                      <p className="truncate text-sm font-medium text-navy-900">
                        {profile?.displayName ?? user?.email}
                      </p>
                      <p className="truncate text-xs text-slate-500">{user?.email}</p>
                      {profile?.officeName && (
                        <p className="mt-0.5 truncate text-xs text-slate-500">
                          {profile.officeName}
                        </p>
                      )}
                      <div className="mt-2 flex flex-wrap gap-1">
                        {roles.map((r) => (
                          <span
                            key={r}
                            className="rounded bg-slate-100 px-1.5 py-0.5 text-2xs text-slate-700"
                          >
                            {ROLE_LABELS[r as Role] ?? r}
                          </span>
                        ))}
                      </div>
                    </div>
                    {/* Not under Administration. Changing your own password
                        is not a permission anybody grants, and the people who
                        most need it are the ones with the fewest menus. */}
                    <Link
                      to="/account/password"
                      onClick={() => setUserMenuOpen(false)}
                      className="block w-full px-3 py-2 text-left text-sm text-navy-800 hover:bg-slate-50"
                    >
                      Change password
                    </Link>
                    <button
                      onClick={() => {
                        setUserMenuOpen(false);
                        void signOut();
                      }}
                      className="w-full border-t border-slate-100 px-3 py-2 text-left text-sm text-navy-800 hover:bg-slate-50"
                    >
                      Sign out
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </header>
    </>
  );
}

function initials(name: string): string {
  const parts = name
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
