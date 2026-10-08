import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { returnPathFrom } from '@/lib/returnTo';
import { formBackTarget } from './reportOrigin';
import { TREASURY_REPORT_SHORT, type TreasuryReportType } from '@/types/enums';

/**
 * Closing a printed form takes the officer back where they were.
 *
 * The form is opened from two places, and "back" means a different thing from
 * each:
 *
 *   FROM THE REPORT'S OWN PAGE - Print the form - back is the report, which
 *   still remembers the list it was opened from.
 *
 *   FROM A LIST - View report, on Accounting > Treasury Reports or a Treasury
 *   register - back is that list, on the tab and filter it was on.
 *
 * Until patch 109 it always went to the report, so View report from the list
 * left the Accountant one screen further from the list than they started,
 * on a page they never asked to open.
 *
 * The button says where it goes, for the same reason the report's does.
 */
export function FormBackButton({
  reportId,
  reportType,
}: {
  reportId: string;
  reportType: TreasuryReportType;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const returnPath = returnPathFrom(location.search);

  const { to, label } = formBackTarget(reportId, returnPath, {
    section: 'Treasury',
    label: TREASURY_REPORT_SHORT[reportType],
  });

  return (
    <Button variant="secondary" onClick={() => navigate(to)}>
      &larr; Back to {label}
    </Button>
  );
}
