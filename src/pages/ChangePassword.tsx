import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader, Card, Alert } from '@/components/ui/Layout';
import { Field, TextInput } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/auth/AuthProvider';
import { passwordProblem, PASSWORD_RULE } from '@/lib/passwordRules';

/**
 * A user changes their own password.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCREEN HAD TO EXIST
 * ---------------------------------------------------------------------------
 * Until now the only password anybody had was the one an administrator typed
 * and handed over. That has two consequences, and both of them are worse than
 * they sound.
 *
 * The administrator knows every password in the building. Not because anybody
 * is dishonest - because that is how the accounts were made. An audit trail
 * that records WHO approved a voucher means something only if the person named
 * is the only one who could have signed in as them.
 *
 * And a password handed over on paper stays on paper. It is in a notebook, or
 * on a note under a keyboard, because the person it was given to never chose
 * it and has no way to replace it with something they can remember.
 *
 * ---------------------------------------------------------------------------
 * THE CURRENT PASSWORD IS ASKED FOR
 * ---------------------------------------------------------------------------
 * Firebase requires a recent sign-in before it will change a password, so this
 * proves the current one first. That requirement is right for an independent
 * reason: the risk this system actually has is a finance workstation left
 * unlocked in a municipal hall. Without the current password, anybody walking
 * past an open session could lock the officer out of their own account.
 */
export default function ChangePassword() {
  const { user, changePassword } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem = newPassword ? passwordProblem(newPassword, { email: user?.email, currentPassword }) : null;
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const ready = Boolean(currentPassword) && Boolean(newPassword) && !problem && !mismatch && !!confirmPassword;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setError(null);
    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      toast.success(
        'Password changed',
        'Use the new one the next time you sign in. Nobody else has been told it.',
      );
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Change your password"
        subtitle={user?.email ?? ''}
        breadcrumbs={[{ label: 'Your account' }, { label: 'Password' }]}
      />

      <Card className="max-w-xl">
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Your current password" htmlFor="current" required>
            <TextInput
              id="current"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </Field>

          <Field label="New password" htmlFor="next" required hint={PASSWORD_RULE}>
            <TextInput
              id="next"
              type="password"
              autoComplete="new-password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              invalid={Boolean(problem)}
            />
          </Field>

          {problem && <Alert tone="warning">{problem}</Alert>}

          <Field label="New password again" htmlFor="confirm" required>
            <TextInput
              id="confirm"
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              invalid={mismatch}
            />
          </Field>

          {mismatch && (
            <Alert tone="warning">
              The two do not match. Type the new password again exactly.
            </Alert>
          )}

          {error && <Alert tone="error">{error}</Alert>}

          <div className="flex gap-2 pt-2">
            <Button type="submit" variant="primary" loading={busy} disabled={!ready}>
              Change password
            </Button>
            <Button type="button" variant="secondary" onClick={() => navigate(-1)}>
              Cancel
            </Button>
          </div>
        </form>
      </Card>

      <Alert tone="info" className="mt-4 max-w-xl">
        CFMS does not keep your password and cannot show it to anybody, including the system
        administrator. If you forget it, use the <strong>Forgotten your password?</strong> link on
        the sign-in screen - the reset goes to your own inbox, so nobody else can take the account
        by asking for it.
      </Alert>
    </div>
  );
}
