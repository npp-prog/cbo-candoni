import { useEffect, useMemo, useState } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  query,
  type DocumentData,
  type Query,
  type QueryConstraint,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';

/**
 * Live Firestore reads.
 *
 * Everything in CBO reads through a snapshot listener rather than a one-shot
 * fetch. In an accounting office several people work the same queue - an
 * encoder submits, a reviewer reviews, the accountant posts - and a stale list
 * leads directly to someone acting on a voucher that has already moved. Live
 * listeners mean a status change appears on every screen showing it, without a
 * refresh.
 *
 * `constraints` is compared by a serialised key rather than by identity, so a
 * caller can build the array inline without re-subscribing on every render.
 */

export interface QueryState<T> {
  data: T[];
  loading: boolean;
  error: string | null;
}

export function useCollection<T = DocumentData>(
  path: string | null,
  constraints: QueryConstraint[] = [],
  deps: unknown[] = [],
): QueryState<T> {
  const [state, setState] = useState<QueryState<T>>({ data: [], loading: true, error: null });

  // The dependency list the caller gives us is what decides when to
  // re-subscribe; QueryConstraint objects are new on every render and cannot
  // be compared usefully.
  const key = useMemo(() => JSON.stringify([path, ...deps]), [path, ...deps]);

  useEffect(() => {
    if (!path) {
      setState({ data: [], loading: false, error: null });
      return;
    }

    setState((s) => ({ ...s, loading: true, error: null }));

    const q: Query = constraints.length
      ? query(collection(db, path), ...constraints)
      : collection(db, path);

    const unsub = onSnapshot(
      q,
      (snap) => {
        setState({
          data: snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T),
          loading: false,
          error: null,
        });
      },
      (err) => {
        // A permission-denied here is usually a rules question, not a bug, and
        // saying so saves a developer half an hour.
        const message =
          err.code === 'permission-denied'
            ? 'Your account does not have permission to view these records.'
            : err.code === 'failed-precondition'
              ? 'This view needs a Firestore index that has not been created yet. The browser console has a link that creates it.'
              : err.message;
        setState({ data: [], loading: false, error: message });
        console.error(`[CBO] Query on ${path} failed:`, err);
      },
    );

    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}

export interface DocState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  exists: boolean;
}

export function useDocument<T = DocumentData>(path: string | null, id: string | null | undefined): DocState<T> {
  const [state, setState] = useState<DocState<T>>({
    data: null,
    loading: true,
    error: null,
    exists: false,
  });

  useEffect(() => {
    if (!path || !id) {
      setState({ data: null, loading: false, error: null, exists: false });
      return;
    }

    setState((s) => ({ ...s, loading: true, error: null }));

    const unsub = onSnapshot(
      doc(db, path, id),
      (snap) => {
        setState({
          data: snap.exists() ? ({ id: snap.id, ...snap.data() } as T) : null,
          loading: false,
          error: null,
          exists: snap.exists(),
        });
      },
      (err) => {
        setState({
          data: null,
          loading: false,
          error:
            err.code === 'permission-denied'
              ? 'Your account does not have permission to view this record.'
              : err.message,
          exists: false,
        });
      },
    );

    return unsub;
  }, [path, id]);

  return state;
}
