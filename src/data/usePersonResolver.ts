import { useMemo } from 'react';
import { useEmployees, usePayees } from '@/data/queries';
import { personResolver, type PersonResolver } from '@/lib/names';

/** Patch 159: one person, one subsidiary - see personResolver in lib/names.ts. */
export function usePersonResolver(): PersonResolver {
  const payees = usePayees();
  const employees = useEmployees();
  return useMemo(
    () => personResolver(payees.data, employees.data),
    [payees.data, employees.data],
  );
}
