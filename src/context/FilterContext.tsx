import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { todayPh } from '@/lib/dates';

/**
 * The fiscal year and fund a user is currently working in.
 *
 * These two dimensions govern nearly every screen in CBO, so they live in one
 * place and are shown permanently in the header rather than being re-selected
 * on each page. Each fund keeps a complete, independent set of books; posting
 * to the wrong one is a real and costly mistake, so the current fund is always
 * visible and never implicit.
 *
 * The selection is kept in sessionStorage rather than localStorage: it should
 * survive a page reload, but a new session should start from the default year
 * rather than silently resuming a year the user set months ago.
 */

export interface FilterState {
  fiscalYear: number;
  fundCode: string;
  period: number | null;
  officeId: string | null;
  setFiscalYear: (year: number) => void;
  setFundCode: (code: string) => void;
  setPeriod: (period: number | null) => void;
  setOfficeId: (officeId: string | null) => void;
}

const FilterContext = createContext<FilterState | null>(null);

const STORAGE_KEY = 'cbo.filters.v1';

interface Stored {
  fiscalYear?: number;
  fundCode?: string;
  period?: number | null;
  officeId?: string | null;
}

function read(): Stored {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Stored) : {};
  } catch {
    // Private browsing, or storage disabled by policy. Not worth failing over.
    return {};
  }
}

export function FilterProvider({ children }: { children: ReactNode }) {
  const initial = read();
  const currentYear = Number(todayPh().slice(0, 4));

  const [fiscalYear, setFiscalYear] = useState<number>(initial.fiscalYear ?? currentYear);
  const [fundCode, setFundCode] = useState<string>(initial.fundCode ?? 'GF');
  const [period, setPeriod] = useState<number | null>(initial.period ?? null);
  const [officeId, setOfficeId] = useState<string | null>(initial.officeId ?? null);

  useEffect(() => {
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ fiscalYear, fundCode, period, officeId }),
      );
    } catch {
      /* ignore */
    }
  }, [fiscalYear, fundCode, period, officeId]);

  const value = useMemo<FilterState>(
    () => ({
      fiscalYear,
      fundCode,
      period,
      officeId,
      setFiscalYear,
      setFundCode,
      setPeriod,
      setOfficeId,
    }),
    [fiscalYear, fundCode, period, officeId],
  );

  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}

export function useFilters(): FilterState {
  const ctx = useContext(FilterContext);
  if (!ctx) throw new Error('useFilters must be used inside a FilterProvider.');
  return ctx;
}
