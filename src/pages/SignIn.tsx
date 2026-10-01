import { useState, type FormEvent } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/Field';
import { Alert } from '@/components/ui/Layout';
import { ENVIRONMENT, IS_PRODUCTION } from '@/lib/firebase';

export function SignIn() {
  const { signIn, error } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await signIn(email, password);
    } catch {
      // The provider has already set a user-facing message.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen">
      {/* Institutional panel. Plain, deliberately: this is a government
          finance system, not a consumer product. */}
      <div className="hidden w-1/2 flex-col justify-between bg-navy-900 p-12 text-white lg:flex">
        <div>
          <div className="flex h-11 w-11 items-center justify-center rounded bg-brand-600 text-base font-bold">
            CFMS
          </div>
          <h1 className="mt-8 text-3xl font-semibold leading-tight">Candoni Financial Management System</h1>
          <p className="mt-2 text-base text-slate-300">
            Integrated Municipal Financial Management System
          </p>
          <div className="mt-8 h-px w-16 bg-brand-500" />
          <p className="mt-8 max-w-md text-sm leading-relaxed text-slate-400">
            One integrated record connecting the Municipal Budget Office, the Municipal Accounting
            Office and the Municipal Treasurer&rsquo;s Office &mdash; from appropriation through
            obligation, disbursement, the General Ledger, bank reconciliation and financial
            reporting.
          </p>
        </div>

        <div className="text-xs text-slate-400">
          <p className="font-medium text-slate-300">Municipal Government of Candoni</p>
          <p>Province of Negros Occidental</p>
          <p className="mt-4">
            Access is granted by the system administrator. All activity in this system is recorded
            in an audit trail available to the Commission on Audit.
          </p>
        </div>
      </div>

      <div className="flex w-full items-center justify-center bg-white px-6 py-12 lg:w-1/2">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <div className="flex h-10 w-10 items-center justify-center rounded bg-brand-600 text-sm font-bold text-white">
              CFMS
            </div>
            <h1 className="mt-4 text-xl font-semibold text-navy-900">Candoni Financial Management System</h1>
            <p className="text-sm text-slate-500">Municipal Government of Candoni</p>
          </div>

          <h2 className="text-lg font-semibold text-navy-900">Sign in</h2>
          <p className="mt-1 text-sm text-slate-500">Use your municipal CFMS account.</p>

          {!IS_PRODUCTION && (
            <Alert tone="warning" className="mt-4">
              You are signing in to the <strong>{ENVIRONMENT}</strong> environment. Records here are
              not the municipality&rsquo;s official books.
            </Alert>
          )}

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <Field label="Email address" htmlFor="email" required>
              <TextInput
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@mgocandoni.gov.ph"
              />
            </Field>

            <Field label="Password" htmlFor="password" required>
              <TextInput
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>

            {error && <Alert tone="error">{error}</Alert>}

            <Button type="submit" variant="primary" fullWidth loading={busy} size="lg">
              Sign in
            </Button>
          </form>

          <p className="mt-6 text-xs leading-relaxed text-slate-500">
            Forgotten password? Contact the system administrator at the Municipal Accounting Office.
            Passwords cannot be reset by email in this system.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Shown to a user who has signed in but whose account carries no roles.
 *
 * New accounts are created with no access at all: a Firebase account by itself
 * must not be a foothold in the municipality's financial records. An
 * administrator grants a role before anything is visible.
 */
export function AwaitingAccess() {
  const { signOut, user } = useAuth();

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-8 text-center shadow-card">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 text-amber-600">
          <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"
            />
          </svg>
        </div>

        <h1 className="mt-5 text-lg font-semibold text-navy-900">Awaiting access</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          Your account <span className="font-medium text-navy-800">{user?.email}</span> has been
          created, but no role has been assigned to it yet. A Super Administrator at the Municipal
          Accounting Office must grant you access before you can use CFMS.
        </p>
        <p className="mt-3 text-xs text-slate-500">
          This is deliberate: an account with no role can see nothing at all.
        </p>

        <Button className="mt-6" onClick={() => void signOut()} fullWidth>
          Sign out
        </Button>
      </div>
    </div>
  );
}
