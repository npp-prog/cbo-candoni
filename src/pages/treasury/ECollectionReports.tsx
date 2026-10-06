import { useState } from 'react';
import TreasuryReports from './TreasuryReports';
import { E_COLLECTION_KINDS } from './eCollectionKinds';
import type { ECollectionReportType } from '@/types/enums';

/**
 * The Report of e-Collections and Deposits - Annexes E, F and G.
 *
 * ---------------------------------------------------------------------------
 * THREE REPORTS, ONE TAB
 * ---------------------------------------------------------------------------
 * COA Circular 2021-014 prescribes three forms and CFMS keeps them three: they
 * carry different columns, they are certified by different officers, and two
 * of them say different things under oath. Merging them would mean one
 * signature standing for three different statements.
 *
 * But to the officer they are one piece of work - "do the eRCD" - and the
 * collections strip already carries ten tabs. Three more would have pushed the
 * thing the clerk uses every day off the first row to make room for a report
 * Candoni may raise twice a month.
 *
 * So: one tab, and the choice of annex made on the page. The underlying
 * register is the same screen the RCI, RADAI, RCD and RCDisb use, handed the
 * chosen type - there is no second implementation of the report list, and
 * nothing here can drift away from the other four.
 */
export default function ECollectionReports() {
  const [reportType, setReportType] = useState<ECollectionReportType>('ERCD_EOR');

  return (
    <TreasuryReports
      reportType={reportType}
      aside={
        <div className="mb-4">
          <p className="cbo-label mb-2">Which report?</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {E_COLLECTION_KINDS.map((k) => {
              const active = k.reportType === reportType;
              return (
                <button
                  key={k.reportType}
                  onClick={() => setReportType(k.reportType)}
                  aria-pressed={active}
                  className={`rounded-lg border p-3 text-left transition ${
                    active
                      ? 'border-navy-500 bg-navy-50 ring-1 ring-navy-200'
                      : 'border-slate-200 bg-white hover:border-slate-300'
                  }`}
                >
                  <p className="text-xs font-semibold text-navy-900">{k.label}</p>
                  <p className="mt-1 text-xs leading-snug text-slate-600">{k.when}</p>
                </button>
              );
            })}
          </div>
        </div>
      }
    />
  );
}
