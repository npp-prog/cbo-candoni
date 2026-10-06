import { useMemo } from 'react';
import { useDocument } from '@/hooks/useFirestore';
import { COL } from '@/lib/collections';
import { entityFrom, type EntityDetails, type EntitySettings } from '@/lib/entity';
import type { SystemSettings } from '@/types/system';

export type { EntityDetails, Official, EntitySettings } from '@/lib/entity';
export { entityFrom } from '@/lib/entity';

/**
 * The municipality's own details, from Settings.
 *
 * The merge itself is in `src/lib/entity.ts` - pure, and testable without
 * standing up Firebase. This is only the read.
 */
export function useEntity(): EntityDetails {
  const { data } = useDocument<SystemSettings & EntitySettings>(COL.settings, 'general');
  return useMemo(() => entityFrom(data), [data]);
}
