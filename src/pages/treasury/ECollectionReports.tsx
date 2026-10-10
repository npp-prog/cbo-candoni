import { useState } from 'react';
import TreasuryReports from './TreasuryReports';
import { Select } from '@/components/ui/Field';
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

  /*
   * Patch 160: the choice of report is a dropdown in the table's toolbar,
   * beside Columns - as the kind is on the e-Collections register - not two
   * cards above it.
   */
  const chosen = E_COLLECTION_KINDS.find((k) => k.reportType === reportType);
  return (
    <TreasuryReports
      reportType={reportType}
      tableFilters={
        <Select
          aria-label="Which report"
          value={reportType}
          onChange={(e) => setReportType(e.target.value as ECollectionReportType)}
          className="w-auto min-w-[16rem]"
          title={chosen?.when}
        >
          {E_COLLECTION_KINDS.map((k) => (
            <option key={k.reportType} value={k.reportType}>
              {k.label}
            </option>
          ))}
        </Select>
      }
    />
  );
}
