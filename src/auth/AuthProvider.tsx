import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  onAuthStateChanged,
  onIdTokenChanged,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  setPersistence,
  browserSessionPersistence,
  sendPasswordResetEmail,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
  type User,
} from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { COL } from '@/lib/collections';
import { permissionsFor, can } from './permissions';
import type { Action, Module, Permission, Role, UserProfile } from '@/types/system';

/**
 * Authentication and the client's view of authorisation.
 *
 * The roles here come from the user's Firebase ID token claims, which are set
 * only by the `setUserRoles` Cloud Function. They are used to decide what to
 * render. They are NOT what protects the data - Firestore Security Rules read
 * the same claims server-side and are the actual boundary. Hiding a button
 * prevents mistakes; it does not prevent anyone determined.
 */

interface AuthState {
  user: User | null;
  profile: UserProfile | null;
  roles: Role[];
  permissions: Set<Permission>;
  loading: boolean;
  /** Signed in, but no roles granted yet - awaiting an administrator. */
  awaitingAccess: boolean;
  error: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /**
   * Change your own password.
   *
   * Takes the CURRENT one as well, and proves it before changing anything.
   * Firebase requires a recent sign-in for this, but that is not the only
   * reason: a workstation left unlocked in a municipal hall is the risk this
   * system actually has, and without the current password anyone walking past
   * an open session could lock the officer out of their own account.
   */
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  /** Send a reset link to an address, without saying whether it exists. */
  sendPasswordReset: (email: string) => Promise<void>;
  can: (module: Module, action: Action) => boolean;
  hasRole: (...roles: Role[]) => boolean;
  /** Offices this user is restricted to; empty means unrestricted. */
  officeScope: string[];
  fundScope: string[];
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Session timeout. A finance workstation left unlocked in a municipal hall is
 * a real risk, and the browser session persistence below means closing the tab
 * already ends the session. This adds an idle timeout on top.
 */
const IDLE_TIMEOUT_MS = 45 * 60 * 1000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [officeScope, setOfficeScope] = useState<string[]>([]);
  const [fundScope, setFundScope] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const idleTimer = useRef<number | undefined>(undefined);

  // Session-scoped persistence: closing the browser signs the user out.
  useEffect(() => {
    setPersistence(auth, browserSessionPersistence).catch(() => {
      /* Falls back to the default; not fatal. */
    });
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (!u) {
        setProfile(null);
        setRoles([]);
        setOfficeScope([]);
        setFundScope([]);
      }
      setLoading(false);
    });
    return unsub;
  }, []);

  // Claims can change while a session is live (an administrator grants or
  // revokes a role). Listening to token changes means the UI follows within
  // the hour without the user signing out and in again.
  useEffect(() => {
    const unsub = onIdTokenChanged(auth, async (u) => {
      if (!u) return;
      try {
        let claims = (await u.getIdTokenResult()).claims;

        // A token is minted at sign-in and reused for an hour. When an
        // administrator grants the first role, the token already in hand still
        // says "no roles", and the user sits on the Awaiting access screen
        // until it expires - which reads as the grant having failed. If the
        // cached token carries no roles, ask the server for a fresh one before
        // concluding the account has none. One extra round trip, only in the
        // case where the answer would otherwise be wrong.
        if (!claims.roles) {
          claims = (await u.getIdTokenResult(true)).claims;
        }

        setRoles((claims.roles as Role[]) ?? []);
        setOfficeScope((claims.officeScope as string[]) ?? []);
        setFundScope((claims.fundScope as string[]) ?? []);
      } catch {
        setRoles([]);
      }
    });
    return unsub;
  }, []);

  // The profile document, for display name and office.
  useEffect(() => {
    if (!user) return;
    const unsub = onSnapshot(
      doc(db, COL.users, user.uid),
      (snap) => {
        setProfile(snap.exists() ? ({ id: snap.id, ...snap.data() } as UserProfile) : null);
      },
      () => setProfile(null),
    );
    return unsub;
  }, [user]);

  // Idle timeout.
  useEffect(() => {
    if (!user) return;

    const reset = () => {
      window.clearTimeout(idleTimer.current);
      idleTimer.current = window.setTimeout(() => {
        void fbSignOut(auth);
        setError('You were signed out after 45 minutes of inactivity.');
      }, IDLE_TIMEOUT_MS);
    };

    const events = ['mousedown', 'keydown', 'scroll', 'touchstart'];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();

    return () => {
      events.forEach((e) => window.removeEventListener(e, reset));
      window.clearTimeout(idleTimer.current);
    };
  }, [user]);

  const permissions = useMemo(() => permissionsFor(roles), [roles]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      profile,
      roles,
      permissions,
      loading,
      awaitingAccess: Boolean(user) && roles.length === 0 && !loading,
      error,
      officeScope,
      fundScope,
      signIn: async (email, password) => {
        setError(null);
        try {
          await signInWithEmailAndPassword(auth, email.trim(), password);
        } catch (e) {
          const code = (e as { code?: string }).code ?? '';
          // Deliberately vague: distinguishing "no such user" from "wrong
          // password" tells an attacker which municipal email addresses exist.
          const message =
            code === 'auth/too-many-requests'
              ? 'Too many attempts. Wait a few minutes before trying again.'
              : code === 'auth/network-request-failed'
                ? 'CFMS could not reach the server. Check the internet connection.'
                : 'That email address and password do not match an active CFMS account.';
          setError(message);
          throw new Error(message);
        }
      },
      signOut: async () => {
        await fbSignOut(auth);
        setError(null);
      },
      changePassword: async (currentPassword, newPassword) => {
        const current = auth.currentUser;
        if (!current?.email) {
          throw new Error('You are not signed in. Sign in again and try once more.');
        }
        try {
          await reauthenticateWithCredential(
            current,
            EmailAuthProvider.credential(current.email, currentPassword),
          );
        } catch (e) {
          const code = (e as { code?: string }).code ?? '';
          throw new Error(
            code === 'auth/too-many-requests'
              ? 'Too many attempts. Wait a few minutes before trying again.'
              : 'That is not your current password.',
          );
        }
        try {
          await updatePassword(current, newPassword);
        } catch (e) {
          const code = (e as { code?: string }).code ?? '';
          throw new Error(
            code === 'auth/weak-password'
              ? 'That password is too easily guessed. Choose a longer one.'
              : 'The password could not be changed. Sign out, sign in again and try once more.',
          );
        }
      },
      sendPasswordReset: async (email) => {
        /*
         * Never says whether the address exists.
         *
         * "No such account" on a municipal address tells whoever typed it
         * which officers have CFMS accounts, which is the first half of an
         * attack on one. The screen says the same thing either way, and the
         * only person who learns anything is the one who can open the inbox.
         */
        try {
          await sendPasswordResetEmail(auth, email.trim());
        } catch (e) {
          const code = (e as { code?: string }).code ?? '';
          if (code === 'auth/too-many-requests') {
            throw new Error('Too many attempts. Wait a few minutes before trying again.');
          }
          if (code === 'auth/network-request-failed') {
            throw new Error('CFMS could not reach the server. Check the internet connection.');
          }
          // auth/user-not-found and auth/invalid-email are swallowed on
          // purpose, for the reason above.
        }
      },
      can: (module, action) => can(permissions, module, action),
      hasRole: (...check) => check.some((r) => roles.includes(r)),
    }),
    [user, profile, roles, permissions, loading, error, officeScope, fundScope],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside an AuthProvider.');
  return ctx;
}
