import { useEffect, useState } from 'react';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { Button } from '@/components/ui/Button';
import { Field, TextInput, Checkbox, Select } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useDocument } from '@/hooks/useFirestore';
import { useAuth } from '@/auth/AuthProvider';
import { upsertMaster, actorStamp } from '@/data/mutations';
import { COL } from '@/lib/collections';
import { ENVIRONMENT } from '@/lib/firebase';
import { ROLES, ROLE_LABELS, type Role, type SystemSettings } from '@/types/system';

/**
 * System settings.
 *
 * Two of these are real internal controls rather than preferences, and both
 * are worth understanding before they are changed:
 *
 *  - Budget override decides whether anyone may certify an obligation beyond
 *    the available allotment. Turning it off makes the budget control
 *    absolute. Leaving it on with a narrow list of roles is the usual
 *    position, since a municipality occasionally needs it.
 *
 *  - Self-approval decides whether the person who prepared a voucher may also
 *    approve it. Off by default. A small office sometimes has no second
 *    reviewer, so it can be relaxed - but that should be a recorded decision
 *    by an administrator, not a silent default.
 */
export default function Settings() {
  const { hasRole, user, profile } = useAuth();
  const toast = useToast();
  const { data } = useDocument<
    SystemSettings & {
      allowSelfApproval?: boolean;
      entityName?: string;
      address?: string;
      officials?: Record<string, { name: string; position: string }>;
    }
  >(
    COL.settings,
    'general',
  );

  const [municipality, setMunicipality] = useState('Municipality of Candoni');
  const [province, setProvince] = useState('Province of Negros Occidental');
  /*
   * The two lines the PRESCRIBED COA FORMS print, which are not the two above.
   *
   * A COA appendix is headed "Republic of the Philippines / MUNICIPAL
   * GOVERNMENT OF CANDONI / Municipal Building, Rizal St., ...". The
   * municipality and province above are what the EXPORTS head their pages
   * with. Both are real and they are different, so both are editable.
   */
  const [entityName, setEntityName] = useState('MUNICIPAL GOVERNMENT OF CANDONI');
  const [address, setAddress] = useState(
    'Municipal Building, Rizal St., Candoni, Negros Occidental, 6110',
  );
  /*
   * Who signs the prescribed forms, by office.
   *
   * Written into the source until patch 89, which meant an election changed
   * who signs and nothing could print correctly until the next patch.
   */
  const [officials, setOfficials] = useState({
    localTreasurer: { name: '', position: 'Local Treasurer' },
    municipalMayor: { name: '', position: 'Municipal Mayor' },
    municipalAccountant: { name: '', position: 'Municipal Accountant' },
    bookkeeper: { name: '', position: 'Bookkeeper' },
  });
  const [checkStaleMonths, setCheckStaleMonths] = useState(6);
  const [sessionTimeoutMinutes, setSessionTimeoutMinutes] = useState(45);
  const [allowBudgetOverride, setAllowBudgetOverride] = useState(true);
  const [budgetOverrideRoles, setBudgetOverrideRoles] = useState<Role[]>(['SUPER_ADMIN', 'BUDGET_OFFICER']);
  const [allowSelfApproval, setAllowSelfApproval] = useState(false);
  const [signatories, setSignatories] = useState({
    preparedBy: { name: '', position: '' },
    reviewedBy: { name: '', position: '' },
    certifiedBy: { name: '', position: '' },
    approvedBy: { name: '', position: '' },
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!data) return;
    setMunicipality(data.municipality ?? 'Municipality of Candoni');
    setProvince(data.province ?? 'Province of Negros Occidental');
    setEntityName(data.entityName ?? 'MUNICIPAL GOVERNMENT OF CANDONI');
    setAddress(
      data.address ?? 'Municipal Building, Rizal St., Candoni, Negros Occidental, 6110',
    );
    if (data.officials) {
      setOfficials((current) => ({
        localTreasurer: data.officials?.localTreasurer ?? current.localTreasurer,
        municipalMayor: data.officials?.municipalMayor ?? current.municipalMayor,
        municipalAccountant: data.officials?.municipalAccountant ?? current.municipalAccountant,
        bookkeeper: data.officials?.bookkeeper ?? current.bookkeeper,
      }));
    }
    setCheckStaleMonths(data.checkStaleMonths ?? 6);
    setSessionTimeoutMinutes(data.sessionTimeoutMinutes ?? 45);
    setAllowBudgetOverride(data.allowBudgetOverride !== false);
    setBudgetOverrideRoles((data.budgetOverrideRoles as Role[]) ?? ['SUPER_ADMIN', 'BUDGET_OFFICER']);
    setAllowSelfApproval(data.allowSelfApproval === true);
    if (data.signatories) {
      setSignatories({
        preparedBy: data.signatories.preparedBy ?? { name: '', position: '' },
        reviewedBy: data.signatories.reviewedBy ?? { name: '', position: '' },
        certifiedBy: data.signatories.certifiedBy ?? { name: '', position: '' },
        approvedBy: data.signatories.approvedBy ?? { name: '', position: '' },
      });
    }
  }, [data]);

  const isAdmin = hasRole('SUPER_ADMIN');

  const save = async () => {
    if (!user) return;
    setSaving(true);
    try {
      await upsertMaster(
        COL.settings,
        'general',
        {
          municipality,
          province,
          entityName: entityName.trim(),
          address: address.trim(),
          officials,
          reportHeaderLines: ['Republic of the Philippines', province, municipality],
          checkStaleMonths,
          sessionTimeoutMinutes,
          allowBudgetOverride,
          budgetOverrideRoles,
          allowSelfApproval,
          signatories,
          cashAdvanceDueDays: data?.cashAdvanceDueDays ?? {
            TRAVEL: 30,
            SPECIAL_ACTIVITY: 20,
            PETTY_CASH: 20,
            PAYROLL: 5,
            FUND_TRANSFER: 60,
            OTHER: 30,
          },
          currentFiscalYear: data?.currentFiscalYear ?? new Date().getFullYear(),
        },
        actorStamp({
          uid: user.uid,
          name: profile?.displayName ?? user.email ?? user.uid,
          position: profile?.position,
        }),
      );
      toast.success('Settings saved', 'The change is recorded in the audit trail.');
    } catch (err) {
      toast.error('Could not save settings', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="System-wide configuration and internal control switches."
        breadcrumbs={[{ label: 'Administration' }, { label: 'Settings' }]}
        actions={
          isAdmin && (
            <Button variant="primary" loading={saving} onClick={() => void save()}>
              Save settings
            </Button>
          )
        }
      />

      {!isAdmin && (
        <Alert tone="info" className="mb-4">
          Only a Super Administrator may change these settings. They are shown here for reference.
        </Alert>
      )}

      <div className="space-y-4">
        <Card title="Identity" subtitle="Printed on the heading of every report.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Municipality" htmlFor="municipality">
              <TextInput
                id="municipality"
                value={municipality}
                onChange={(e) => setMunicipality(e.target.value)}
                disabled={!isAdmin}
              />
            </Field>
            <Field label="Province" htmlFor="province">
              <TextInput
                id="province"
                value={province}
                onChange={(e) => setProvince(e.target.value)}
                disabled={!isAdmin}
              />
            </Field>

            <Field
              label="Entity name, as the COA forms print it"
              htmlFor="entityName"
              className="sm:col-span-2"
              hint="The second line of every prescribed appendix, in capitals."
            >
              <TextInput
                id="entityName"
                value={entityName}
                onChange={(e) => setEntityName(e.target.value)}
                disabled={!isAdmin}
              />
            </Field>

            <Field
              label="Address"
              htmlFor="address"
              className="sm:col-span-2"
              hint="The third line. A COA appendix carries the street address where an export carries the province."
            >
              <TextInput
                id="address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                disabled={!isAdmin}
              />
            </Field>
          </div>
        </Card>

        <Card
          title="Officials"
          subtitle="Printed over the signature lines of the prescribed COA forms. Leave a name empty and the line prints blank, to be signed by hand."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {(
              [
                ['localTreasurer', 'Local Treasurer'],
                ['municipalMayor', 'Municipal Mayor'],
                ['municipalAccountant', 'Municipal Accountant'],
                ['bookkeeper', 'Bookkeeper'],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label} htmlFor={key}>
                <TextInput
                  id={key}
                  value={officials[key].name}
                  onChange={(e) =>
                    setOfficials((o) => ({ ...o, [key]: { ...o[key], name: e.target.value } }))
                  }
                  disabled={!isAdmin}
                  placeholder="Name as it is printed"
                />
              </Field>
            ))}
          </div>

          <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-center">
            <p className="text-xs text-navy-700">Republic of the Philippines</p>
            <p className="text-xs text-navy-700">{province}</p>
            <p className="text-sm font-semibold uppercase tracking-wide text-navy-900">{municipality}</p>
          </div>
        </Card>

        <Card
          title="Internal controls"
          subtitle="These change what the accounting engine permits. Every change is recorded in the audit trail."
        >
          <div className="space-y-5">
            <div>
              <Checkbox
                checked={allowBudgetOverride}
                onChange={setAllowBudgetOverride}
                disabled={!isAdmin}
                label="Allow obligations beyond the available allotment, with an authorised override"
                hint="When off, the budget control is absolute: an obligation exceeding the available allotment is refused outright, whoever attempts it."
              />

              {allowBudgetOverride && (
                <div className="mt-3 pl-7">
                  <p className="cbo-label">Roles that may override</p>
                  <div className="flex flex-wrap gap-3">
                    {ROLES.map((role) => (
                      <label key={role} className="flex items-center gap-1.5 text-xs text-navy-800">
                        <input
                          type="checkbox"
                          checked={budgetOverrideRoles.includes(role)}
                          disabled={!isAdmin}
                          onChange={(e) =>
                            setBudgetOverrideRoles((rs) =>
                              e.target.checked ? [...rs, role] : rs.filter((r) => r !== role),
                            )
                          }
                          className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                        />
                        {ROLE_LABELS[role]}
                      </label>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    Every override requires a written reason, is printed on the face of the OBR,
                    is logged as a critical audit event and notifies the Municipal Accountant.
                  </p>
                </div>
              )}
            </div>

            <div className="border-t border-slate-200 pt-4">
              <Checkbox
                checked={allowSelfApproval}
                onChange={setAllowSelfApproval}
                disabled={!isAdmin}
                label="Allow a user to approve a document they prepared themselves"
                hint="Off by default. Turn this on only where the office genuinely has no second reviewer - it removes the four-eyes control from every voucher and journal entry."
              />
              {allowSelfApproval && (
                <Alert tone="warning" className="mt-3">
                  Self-approval is enabled. One person can now carry a voucher from preparation
                  through to approval without a second pair of eyes. COA will treat this as a
                  control weakness; consider granting the reviewer role to another officer
                  instead.
                </Alert>
              )}
            </div>
          </div>
        </Card>

        <Card title="Operational">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Checks become stale after"
              htmlFor="stale"
              hint="Months. Six is the standard banking practice in the Philippines."
            >
              <Select
                id="stale"
                value={checkStaleMonths}
                onChange={(e) => setCheckStaleMonths(Number(e.target.value))}
                disabled={!isAdmin}
              >
                {[3, 6, 12].map((m) => (
                  <option key={m} value={m}>
                    {m} months
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Sign out after inactivity"
              htmlFor="timeout"
              hint="A finance workstation left unlocked in a municipal hall is a real risk."
            >
              <Select
                id="timeout"
                value={sessionTimeoutMinutes}
                onChange={(e) => setSessionTimeoutMinutes(Number(e.target.value))}
                disabled={!isAdmin}
              >
                {[15, 30, 45, 60, 120].map((m) => (
                  <option key={m} value={m}>
                    {m} minutes
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>

        <Card title="Default report signatories" subtitle="Printed in the signature block of reports.">
          <div className="grid gap-4 sm:grid-cols-2">
            {(['preparedBy', 'reviewedBy', 'certifiedBy', 'approvedBy'] as const).map((key) => (
              <div key={key} className="grid grid-cols-2 gap-2">
                <Field label={`${labelFor(key)} - name`}>
                  <TextInput
                    value={signatories[key]?.name ?? ''}
                    disabled={!isAdmin}
                    onChange={(e) =>
                      setSignatories((s) => ({ ...s, [key]: { ...s[key], name: e.target.value } }))
                    }
                  />
                </Field>
                <Field label="Position">
                  <TextInput
                    value={signatories[key]?.position ?? ''}
                    disabled={!isAdmin}
                    onChange={(e) =>
                      setSignatories((s) => ({ ...s, [key]: { ...s[key], position: e.target.value } }))
                    }
                  />
                </Field>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Environment">
          <dl className="grid gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-2xs uppercase tracking-wider text-slate-500">Deployment</dt>
              <dd className="mt-0.5 text-navy-900">{ENVIRONMENT}</dd>
            </div>
            <div>
              <dt className="text-2xs uppercase tracking-wider text-slate-500">Production URL</dt>
              <dd className="mt-0.5 font-mono text-xs text-navy-900">cbo.mgocandoni.com</dd>
            </div>
            <div>
              <dt className="text-2xs uppercase tracking-wider text-slate-500">Municipal website</dt>
              <dd className="mt-0.5 font-mono text-xs text-navy-900">mgocandoni.com</dd>
            </div>
          </dl>
        </Card>
      </div>
    </div>
  );
}

function labelFor(key: string): string {
  switch (key) {
    case 'preparedBy':
      return 'Prepared by';
    case 'reviewedBy':
      return 'Reviewed by';
    case 'certifiedBy':
      return 'Certified by';
    default:
      return 'Approved by';
  }
}
