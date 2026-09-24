import { useMemo, useState } from 'react';
import { PageHeader, Alert } from '@/components/ui/Layout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Field, Checkbox, Select, TextInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/auth/AuthProvider';
import { useUsers, useOffices } from '@/data/queries';
import { engine } from '@/lib/engine';
import { formatInstant } from '@/lib/dates';
import { segregationWarnings, DEFAULT_ROLE_PERMISSIONS } from '@/auth/permissions';
import { ROLES, ROLE_LABELS, type Role, type UserProfile } from '@/types/system';

/**
 * Users and roles.
 *
 * Roles are stored as Firebase Auth custom claims, not as a field on the user
 * document, because claims are signed by Firebase and are what Firestore
 * Security Rules can read. A user editing their own profile cannot grant
 * themselves anything - the rules forbid writing the roles field, and the
 * rules read the claim rather than the document in any case.
 *
 * Segregation of duties is warned about rather than blocked. In a municipal
 * accounting office with four staff, one person sometimes must both encode and
 * review. What matters is that the combination is a deliberate, recorded
 * decision rather than something that accumulated unnoticed.
 */
export default function Users() {
  const { data, loading, error } = useUsers();
  const offices = useOffices();
  const { user: currentUser } = useAuth();
  const toast = useToast();
  const [editing, setEditing] = useState<UserProfile | null>(null);
  const [adding, setAdding] = useState(false);

  const activeAdmins = data.filter((u) => u.active && u.roles?.includes('SUPER_ADMIN')).length;
  const noRoles = data.filter((u) => u.active && (u.roles?.length ?? 0) === 0);

  const columns: Column<UserProfile>[] = [
    {
      key: 'name',
      header: 'User',
      value: (u) => u.displayName,
      cell: (u) => (
        <div>
          <span className="text-sm text-navy-900">{u.displayName}</span>
          <span className="block text-xs text-slate-500">{u.email}</span>
        </div>
      ),
    },
    {
      key: 'position',
      header: 'Position and office',
      value: (u) => u.position ?? '',
      cell: (u) => (
        <div className="text-xs text-slate-600">
          {u.position ?? <span className="text-slate-400">-</span>}
          {u.officeName && <span className="block">{u.officeName}</span>}
        </div>
      ),
    },
    {
      key: 'roles',
      header: 'Roles',
      value: (u) => (u.roles ?? []).join(', '),
      cell: (u) => (
        <div className="flex flex-wrap gap-1">
          {(u.roles ?? []).length === 0 ? (
            <Badge tone="amber">No access</Badge>
          ) : (
            (u.roles ?? []).map((r) => (
              <Badge key={r} tone={r === 'SUPER_ADMIN' ? 'violet' : r === 'AUDITOR' ? 'slate' : 'blue'}>
                {ROLE_LABELS[r as Role] ?? r}
              </Badge>
            ))
          )}
        </div>
      ),
    },
    {
      key: 'scope',
      header: 'Scope',
      value: (u) => (u.officeScope ?? []).length,
      cell: (u) =>
        (u.officeScope ?? []).length > 0 ? (
          <span className="text-xs text-slate-600">
            {u.officeScope.length} office{u.officeScope.length === 1 ? '' : 's'}
          </span>
        ) : (
          <span className="text-xs text-slate-400">All offices</span>
        ),
      optional: true,
    },
    {
      key: 'lastLogin',
      header: 'Last sign-in',
      value: (u) => u.lastLoginAt ?? '',
      cell: (u) => <span className="text-xs text-slate-600">{formatInstant(u.lastLoginAt) || '-'}</span>,
    },
    {
      key: 'actions',
      header: '',
      width: '10rem',
      sortable: false,
      fixed: true,
      value: (u) => (u.active ? 'Active' : 'Inactive'),
      cell: (u) => (
        <div className="flex items-center justify-end gap-1.5">
          {!u.active && <Badge tone="rose">Deactivated</Badge>}
          <Button size="sm" onClick={() => setEditing(u)}>
            Manage access
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Users and Roles"
        subtitle="Access to CBO is granted role by role. A new account can see nothing until a role is assigned."
        breadcrumbs={[{ label: 'Administration' }, { label: 'Users and Roles' }]}
        actions={
          <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
            Add user
          </Button>
        }
      />

      {activeAdmins <= 1 && (
        <Alert tone="warning" className="mb-4" title="Only one Super Administrator">
          If this account is lost, nobody can grant roles, close periods or reopen them. Assign the
          Super Administrator role to a second trusted officer.
        </Alert>
      )}

      {noRoles.length > 0 && (
        <Alert tone="info" className="mb-4">
          {noRoles.length} account{noRoles.length === 1 ? '' : 's'} have signed in but have no role
          assigned and can see nothing. Grant access, or leave them as they are if they should not
          have any.
        </Alert>
      )}

      <DataTable
        rows={data}
        columns={columns}
        rowKey={(u) => u.id}
        loading={loading}
        error={error}
        searchPlaceholder="Name, email or role"
        emptyTitle="No users"
        emptyMessage="Add a user by the email address of their Firebase Authentication account, or wait for them to sign in once."
        exportMeta={{ title: 'CBO User Access Report' }}
      />

      {adding && (
        <AddUserDialog
          offices={offices.data}
          onClose={() => setAdding(false)}
          onAdded={(email) => {
            setAdding(false);
            toast.success(
              'Access granted',
              `${email} can use CBO from their next sign-in. They appear in the list now.`,
            );
          }}
        />
      )}

      {editing && (
        <AccessDialog
          user={editing}
          offices={offices.data}
          isSelf={editing.uid === currentUser?.uid}
          onClose={() => setEditing(null)}
          onSaved={(warnings) => {
            setEditing(null);
            if (warnings.length > 0) {
              toast.warning(
                'Access updated, with a segregation of duties concern',
                `This user can now ${warnings.join('; ')}. The combination has been recorded in the audit trail.`,
              );
            } else {
              toast.success('Access updated', 'The change takes effect on their next request.');
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * Granting access to somebody who has not signed in yet.
 *
 * The table can only offer a user it already knows about, and CBO learns about
 * a user when they first sign in. That is the wrong way round for an office:
 * the administrator wants to prepare an account before handing it over, and if
 * the sign-in hook ever stops provisioning profiles, the table stays empty and
 * nobody can be granted anything at all - including a replacement
 * administrator.
 *
 * So access can also be granted by email. The Firebase Authentication account
 * has to exist first; this screen does not create credentials, and should not
 * be able to.
 */
function AddUserDialog({
  offices,
  onClose,
  onAdded,
}: {
  offices: Array<{ id: string; name: string }>;
  onClose: () => void;
  onAdded: (email: string) => void;
}) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role | ''>('');
  const [officeId, setOfficeId] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!email.trim() || !role) return;
    setBusy(true);
    try {
      await engine.setUserRoles({
        email: email.trim(),
        roles: [role],
        officeScope: officeId ? [officeId] : [],
      });
      onAdded(email.trim());
    } catch (err) {
      toast.error('Could not grant access', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Add a user"
      description="Grants access to an existing Firebase Authentication account."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={busy || !email.trim() || !role}
            onClick={() => void submit()}
          >
            Grant access
          </Button>
        </>
      }
    >
      <Field
        label="Email address"
        required
        htmlFor="newUserEmail"
        hint="The account must already exist in Firebase Authentication. Create it there first if it does not."
      >
        <TextInput
          id="newUserEmail"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@mgocandoniaccounting.org"
        />
      </Field>

      <Field label="Role" required htmlFor="newUserRole" className="mt-4">
        <Select id="newUserRole" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="">Choose a role</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Restrict to one office"
        htmlFor="newUserOffice"
        className="mt-4"
        hint="Leave blank for accounting, budget and treasury staff, who work across every office."
      >
        <Select id="newUserOffice" value={officeId} onChange={(e) => setOfficeId(e.target.value)}>
          <option value="">Every office</option>
          {offices.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
      </Field>

      <Alert tone="info" className="mt-4">
        More roles, and the segregation of duties check, are available from Manage access once the
        user is in the list.
      </Alert>
    </Modal>
  );
}

function AccessDialog({
  user,
  offices,
  isSelf,
  onClose,
  onSaved,
}: {
  user: UserProfile;
  offices: Array<{ id: string; name: string }>;
  isSelf: boolean;
  onClose: () => void;
  onSaved: (warnings: string[]) => void;
}) {
  const toast = useToast();
  const [roles, setRoles] = useState<Role[]>((user.roles ?? []) as Role[]);
  const [officeScope, setOfficeScope] = useState<string[]>(user.officeScope ?? []);
  const [fundScope, setFundScope] = useState<string[]>(user.fundScope ?? []);
  const [active, setActive] = useState(user.active !== false);
  const [saving, setSaving] = useState(false);

  const warnings = useMemo(() => segregationWarnings(roles), [roles]);
  const permissionCount = useMemo(
    () => new Set(roles.flatMap((r) => DEFAULT_ROLE_PERMISSIONS[r] ?? [])).size,
    [roles],
  );

  const save = async () => {
    setSaving(true);
    try {
      const result = await engine.setUserRoles({
        uid: user.uid,
        roles,
        officeScope,
        fundScope,
      });
      onSaved(result.segregationWarnings ?? []);
    } catch (err) {
      toast.error('Could not update access', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Access for ${user.displayName}`}
      description={user.email}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save access
          </Button>
        </>
      }
    >
      {isSelf && (
        <Alert tone="warning" className="mb-4">
          You are editing your own access. Removing your own Super Administrator role is refused
          if you are the last active administrator.
        </Alert>
      )}

      <div className="space-y-2">
        <p className="cbo-label">Roles</p>
        {ROLES.map((role) => (
          <label
            key={role}
            className="flex cursor-pointer items-start gap-2.5 rounded-md border border-slate-200 px-3 py-2 hover:bg-slate-50"
          >
            <input
              type="checkbox"
              checked={roles.includes(role)}
              onChange={(e) =>
                setRoles((rs) => (e.target.checked ? [...rs, role] : rs.filter((r) => r !== role)))
              }
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            <div className="min-w-0">
              <span className="text-sm font-medium text-navy-900">{ROLE_LABELS[role]}</span>
              <span className="block text-xs text-slate-500">{roleDescription(role)}</span>
            </div>
          </label>
        ))}
      </div>

      {warnings.length > 0 && (
        <Alert tone="warning" className="mt-4" title="Segregation of duties">
          <ul className="list-inside list-disc space-y-0.5">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs">
            This is permitted - a small office sometimes has no alternative - but it is recorded as
            a critical audit event, and COA will see it.
          </p>
        </Alert>
      )}

      <div className="mt-5">
        <p className="cbo-label">Office restriction</p>
        <p className="mb-2 text-xs text-slate-500">
          Leave empty for unrestricted access. A Department User with offices selected sees only
          those offices&rsquo; transactions - enforced by security rules, not just by the interface.
        </p>
        <div className="max-h-44 overflow-y-auto rounded-md border border-slate-200 p-2">
          {offices.map((office) => (
            <label key={office.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-slate-50">
              <input
                type="checkbox"
                checked={officeScope.includes(office.id)}
                onChange={(e) =>
                  setOfficeScope((s) => (e.target.checked ? [...s, office.id] : s.filter((x) => x !== office.id)))
                }
                className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              <span className="text-navy-800">{office.name}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="mt-5">
        <p className="cbo-label">Fund restriction</p>
        <div className="flex flex-wrap gap-3">
          {['GF', 'SEF', 'TF'].map((fund) => (
            <label key={fund} className="flex items-center gap-2 text-sm text-navy-800">
              <input
                type="checkbox"
                checked={fundScope.includes(fund)}
                onChange={(e) =>
                  setFundScope((s) => (e.target.checked ? [...s, fund] : s.filter((x) => x !== fund)))
                }
                className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              {fund}
            </label>
          ))}
          <span className="text-xs text-slate-500">Leave all unchecked for access to every fund.</span>
        </div>
      </div>

      <div className="mt-5 border-t border-slate-200 pt-4">
        <Checkbox
          checked={active}
          onChange={setActive}
          label="Account is active"
          hint="Deactivating revokes the session immediately and blocks the next sign-in. The user record and their history are kept."
        />
        <p className="mt-3 text-xs text-slate-500">
          This selection grants {permissionCount} distinct permissions. The change takes effect on
          the user&rsquo;s next request; their existing session token is revoked so it applies at
          once.
        </p>
      </div>
    </Modal>
  );
}

function roleDescription(role: Role): string {
  switch (role) {
    case 'SUPER_ADMIN':
      return 'Full access, including user management and accounting period control.';
    case 'MUNICIPAL_ACCOUNTANT':
      return 'Approves vouchers and posts journal entries to the General Ledger.';
    case 'ACCOUNTING_REVIEWER':
      return 'Reviews vouchers and journal entries before approval.';
    case 'ACCOUNTING_ENCODER':
      return 'Creates and edits accounting transactions; cannot approve or post.';
    case 'BUDGET_OFFICER':
      return 'Approves appropriations and certifies obligations as to availability of allotment.';
    case 'BUDGET_STAFF':
      return 'Prepares appropriations, allotments and obligations; cannot certify.';
    case 'MUNICIPAL_TREASURER':
      return 'Approves collections, deposits and payments; manages bank accounts.';
    case 'TREASURY_STAFF':
      return 'Records collections and deposits; cannot approve them.';
    case 'DEPARTMENT_USER':
      return 'Raises obligations and vouchers for their own office only.';
    case 'AUDITOR':
      return 'Read-only across the whole system, including supporting documents and the audit trail.';
  }
}
