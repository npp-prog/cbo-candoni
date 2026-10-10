import { useEffect } from 'react';

/**
 * Patch 156 - the file name a printed document is saved under.
 *
 * "Save as PDF" in the print dialogue offers the page's title as the file
 * name. CFMS's title is "CFMS", so every PDF came out as CFMS.pdf. While a
 * printable document is on screen the title is set to what the document is
 * and its number - "Report of Checks Issued_2026-10-0001" - and put back when
 * the page is left. It works for the Print button and for Ctrl+P alike.
 */
export function printFileName(type: string, no?: string | null): string {
  const clean = (x: string) =>
    x
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  const t = clean(type);
  const n = clean(String(no ?? ''));
  return n ? `${t}_${n}` : t;
}

/** Sets the page title to `name` while the component is mounted. */
export function usePrintTitle(name: string | null | undefined): void {
  useEffect(() => {
    if (!name) return;
    const before = document.title;
    document.title = name;
    return () => {
      document.title = before;
    };
  }, [name]);
}

/** Prints now, under `name`, and restores the title when the dialogue closes. */
export function printAs(name: string): void {
  const before = document.title;
  document.title = name;
  const restore = () => {
    document.title = before;
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  window.print();
  // Browsers that print synchronously have already fired afterprint.
  window.setTimeout(restore, 1000);
}
