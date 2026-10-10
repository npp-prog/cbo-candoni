import { useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Layout';
import { Field, Select } from '@/components/ui/Field';
import { useAuth } from '@/auth/AuthProvider';
import { useFilters } from '@/context/FilterContext';
import { useEntity } from '@/data/useEntity';
import {
  useAccountableFormTypes,
  useAccounts,
  usePayees,
  useEmployees,
  useFormMovements,
  useFunds,
} from '@/data/queries';
import { app } from '@/lib/firebase';
import { todayPh } from '@/lib/dates';
import {
  SETUP_FORMAT,
  SETUP_VERSION,
  isPerParty,
  subsidiaryLedgers,
  setupFileName,
  type OfflineSetup,
} from '@/lib/offlineCollections';

/**
 * Patch 173 - Treasury > Collections > Offline app setup.
 *
 * Downloads the setup file for the CFMS Collections offline app, for one
 * collecting officer. See src/lib/offlineCollections.ts. Everything in it is
 * read here, in the browser, from data the officer's office can already see;
 * nothing is written.
 */
export function OfflineSetupDownload({ onClose }: { onClose: () => void }) {
  const { fiscalYear } = useFilters();
  const { profile, user } = useAuth();
  const entity = useEntity();
  const employees = useEmployees();
  const funds = useFunds();
  /* Patch 174: the postable accounts, as CFMS's collection form offers them. */
  const accounts = useAccounts(true);
  /* Patch 174: the subsidiary ledgers - Names, as the upload matches them. */
  const payees = usePayees();
  const formTypes = useAccountableFormTypes();
  const movementsNow = useFormMovements(fiscalYear);
  const movementsBefore = useFormMovements(fiscalYear - 1);
  const [officerId, setOfficerId] = useState('');

  const loading =
    employees.loading ||
    payees.loading ||
    funds.loading ||
    accounts.loading ||
    formTypes.loading ||
    movementsNow.loading ||
    movementsBefore.loading;

  const officer = employees.data.find((e) => e.id === officerId);

  const mine = useMemo(
    () =>
      [...movementsNow.data, ...movementsBefore.data].filter(
        (m) => !m.voided && (m.custodianId === officerId || m.fromCustodianId === officerId),
      ),
    [movementsNow.data, movementsBefore.data, officerId],
  );

  const download = () => {
    if (!officer) return;
    const setup: OfflineSetup = {
      format: SETUP_FORMAT,
      version: SETUP_VERSION,
      projectId: app.options.projectId ?? '',
      generatedAt: new Date().toISOString(),
      generatedBy: profile?.displayName ?? user?.email ?? '',
      fiscalYear,
      headingLines: entity.headingLines,
      treasurer: { name: entity.localTreasurer.name, position: entity.localTreasurer.position },
      officer: { id: officer.id, name: officer.displayName, position: officer.position ?? '' },
      funds: funds.data.map((f) => ({ code: f.code, name: f.name })),
      accounts: accounts.data.map((a) => ({
        code: a.code,
        name: a.name,
        perParty: isPerParty(a.code, a.requiresSubsidiary),
      })),
      subsidiaries: subsidiaryLedgers(payees.data, employees.data),
      formTypes: formTypes.data.map((t) => ({
        code: t.code,
        name: t.name,
        printedAs: t.printedAs,
        serialLength: t.serialLength ?? 0,
      })),
      movements: mine.map((m) => ({
        formCode: m.formCode,
        kind: m.kind,
        movementDate: m.movementDate,
        serialFrom: m.serialFrom,
        serialTo: m.serialTo,
        custodianId: m.custodianId ?? null,
        fromCustodianId: m.fromCustodianId ?? null,
        voided: false,
      })),
    };
    const blob = new Blob([JSON.stringify(setup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = setupFileName(officer.displayName, todayPh());
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const issues = mine.filter((m) => m.kind === 'ISSUE' && m.custodianId === officerId);

  return (
    <Modal
      open
      onClose={onClose}
      title="Offline app setup file"
      description="For the CFMS Collections app on a collecting officer's laptop."
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" disabled={!officer || loading} onClick={download}>
            Download setup file
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-700">
        The file carries what the app needs to record receipts exactly as CFMS will accept them: the
        funds, the Chart of Accounts, the accountable form types, and the booklets issued to the
        officer. Load it in the app under Settings. Download it again after issuing the officer new
        booklets or adding accounts.
      </p>
      <Field label="Collecting officer" className="mt-3">
        <Select value={officerId} onChange={(e) => setOfficerId(e.target.value)}>
          <option value="">Choose the officer</option>
          {employees.data.map((e) => (
            <option key={e.id} value={e.id}>
              {e.displayName}
              {e.position ? ` - ${e.position}` : ''}
            </option>
          ))}
        </Select>
      </Field>
      {officer && !loading && (
        <Alert tone={issues.length ? 'info' : 'warning'} className="mt-3">
          {issues.length
            ? `${issues.length} booklet issue${issues.length === 1 ? '' : 's'} to ${officer.displayName} in ${fiscalYear - 1}-${fiscalYear} go into the file.`
            : `No booklet has been issued to ${officer.displayName} in ${fiscalYear - 1}-${fiscalYear}. The app can still record e-collections, but no counter receipt until a booklet is issued (Treasury > Accountable Forms > Issue) and the file downloaded again.`}
        </Alert>
      )}
    </Modal>
  );
}
