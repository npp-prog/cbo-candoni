import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { doc, updateDoc } from 'firebase/firestore';
import { limit, orderBy, where } from 'firebase/firestore';
import { PageHeader, Card, EmptyState } from '@/components/ui/Layout';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useCollection } from '@/hooks/useFirestore';
import { useAuth } from '@/auth/AuthProvider';
import { db } from '@/lib/firebase';
import { COL } from '@/lib/collections';
import { formatInstant } from '@/lib/dates';
import type { Notification } from '@/types/system';

/**
 * In-system notifications.
 *
 * Two kinds arrive here: those addressed to a user directly (a voucher they
 * raised was returned) and those addressed to a role (a journal entry is
 * waiting for the Municipal Accountant). Role-addressed notifications are how
 * work reaches whoever is on duty rather than whoever happened to be named.
 *
 * Marking as read is the only change a user can make - security rules deny
 * everything else, because a notification about an overdue cash advance should
 * not be deletable by the person it concerns.
 */
export default function Notifications() {
  const { user, roles } = useAuth();

  const mine = useCollection<Notification>(
    user ? COL.notifications : null,
    [where('recipientUid', '==', user?.uid ?? ''), orderBy('createdAt', 'desc'), limit(100)],
    ['notifications-mine', user?.uid],
  );

  const byRole = useCollection<Notification>(
    roles.length ? COL.notifications : null,
    [where('recipientRole', 'in', roles.slice(0, 10)), orderBy('createdAt', 'desc'), limit(100)],
    ['notifications-role', roles.join(',')],
  );

  const all = useMemo(() => {
    const seen = new Set<string>();
    return [...mine.data, ...byRole.data]
      .filter((n) => {
        if (seen.has(n.id)) return false;
        seen.add(n.id);
        return true;
      })
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  }, [mine.data, byRole.data]);

  const unread = all.filter((n) => !n.read);

  const markRead = async (n: Notification) => {
    // Only notifications addressed to this user personally are writable; a
    // role-addressed one belongs to the role, not to whoever opened it.
    if (n.recipientUid !== user?.uid) return;
    try {
      await updateDoc(doc(db, COL.notifications, n.id), {
        read: true,
        readAt: new Date().toISOString(),
      });
    } catch {
      /* Not worth interrupting the user over. */
    }
  };

  const markAllRead = async () => {
    await Promise.all(unread.filter((n) => n.recipientUid === user?.uid).map(markRead));
  };

  return (
    <div>
      <PageHeader
        title="Notifications"
        subtitle={unread.length > 0 ? `${unread.length} unread` : 'Nothing unread'}
        breadcrumbs={[{ label: 'Notifications' }]}
        actions={
          unread.some((n) => n.recipientUid === user?.uid) && (
            <Button size="sm" onClick={() => void markAllRead()}>
              Mark mine as read
            </Button>
          )
        }
      />

      {all.length === 0 ? (
        <Card>
          <EmptyState
            title="Nothing to show"
            message="Notifications appear when a document needs your attention, a voucher you raised is returned, or a control threshold is crossed."
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {all.map((n) => (
            <div
              key={n.id}
              className={`cbo-card flex items-start gap-3 px-4 py-3 ${n.read ? 'opacity-60' : ''}`}
            >
              <span
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                  n.severity === 'CRITICAL'
                    ? 'bg-rose-600'
                    : n.severity === 'WARNING'
                      ? 'bg-amber-500'
                      : 'bg-brand-500'
                }`}
                aria-hidden="true"
              />

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <p className="text-sm font-medium text-navy-900">{n.title}</p>
                  {n.recipientRole && <Badge tone="slate">{n.recipientRole.replace(/_/g, ' ')}</Badge>}
                  <span className="ml-auto text-2xs text-slate-400">{formatInstant(n.createdAt)}</span>
                </div>
                <p className="mt-0.5 text-sm text-slate-600">{n.body}</p>
                {n.link && (
                  <Link
                    to={n.link}
                    onClick={() => void markRead(n)}
                    className="mt-1 inline-block text-xs font-medium text-brand-700 hover:underline"
                  >
                    Open
                  </Link>
                )}
              </div>

              {!n.read && n.recipientUid === user?.uid && (
                <Button size="sm" variant="ghost" onClick={() => void markRead(n)}>
                  Mark read
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
