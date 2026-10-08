import type { Appropriation } from '@/types/budget';

/** The draft lines of one uploaded ordinance, gathered. */
export interface UploadGroup {
  reference: string;
  kind: string;
  ids: string[];
  total: number;
  fileName: string | null;
  uploadedBy: string | null;
}

/**
 * Draft appropriations that came from a file, by upload. A line typed on the
 * screen carries no importReference and is approved on its own, as before.
 */
export function uploadedDrafts(rows: Appropriation[]): UploadGroup[] {
  const map = new Map<string, UploadGroup>();
  for (const a of rows) {
    if (a.status !== 'DRAFT' || !a.importReference) continue;
    const g = map.get(a.importReference) ?? {
      reference: a.importReference,
      kind: a.kind,
      ids: [],
      total: 0,
      fileName: a.importFileName ?? null,
      uploadedBy: a.createdBy?.name ?? null,
    };
    g.ids.push(a.id);
    g.total += a.amount;
    map.set(a.importReference, g);
  }
  return [...map.values()].sort((a, b) => a.reference.localeCompare(b.reference));
}
