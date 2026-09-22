import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';

/**
 * A searchable picker.
 *
 * Built rather than imported because the requirements are specific: an
 * accounting clerk types an account *code* far more often than a name, so the
 * search matches the code first and ranks a code prefix above a name match.
 * Keyboard-first, because the people using this all day are keying from paper
 * and will not reach for a mouse between fields.
 */

export interface Option {
  value: string;
  /** Shown in bold, matched first: an account code, a payee code. */
  code?: string;
  label: string;
  /** Secondary line: classification, TIN, office. */
  detail?: string;
  disabled?: boolean;
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder = 'Select',
  emptyMessage = 'No matches',
  disabled,
  invalid,
  id,
  allowClear = true,
  loading,
}: {
  options: Option[];
  value: string | null;
  onChange: (value: string | null, option: Option | null) => void;
  placeholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  allowClear?: boolean;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = useMemo(() => options.find((o) => o.value === value) ?? null, [options, value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options.slice(0, 200);

    const scored = options
      .map((o) => {
        const code = (o.code ?? '').toLowerCase();
        const label = o.label.toLowerCase();
        const detail = (o.detail ?? '').toLowerCase();

        // Ranked: a code that starts with the query is almost always what was
        // meant; a detail match is the weakest signal.
        let score = -1;
        if (code.startsWith(q)) score = 0;
        else if (label.startsWith(q)) score = 1;
        else if (code.includes(q)) score = 2;
        else if (label.includes(q)) score = 3;
        else if (detail.includes(q)) score = 4;

        return { option: o, score };
      })
      .filter((s) => s.score >= 0)
      .sort((a, b) => a.score - b.score);

    return scored.slice(0, 200).map((s) => s.option);
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  useEffect(() => {
    setHighlight(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.children[highlight] as HTMLElement | undefined;
    node?.scrollIntoView({ block: 'nearest' });
  }, [highlight, open]);

  const commit = (option: Option) => {
    if (option.disabled) return;
    onChange(option.value, option);
    setQuery('');
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <div
        className={clsx(
          'cbo-input flex cursor-text items-center gap-2 py-1.5',
          invalid && 'border-rose-400',
          disabled && 'cursor-not-allowed bg-slate-50',
        )}
        onClick={() => {
          if (disabled) return;
          setOpen(true);
          inputRef.current?.focus();
        }}
      >
        {open ? (
          <input
            id={id}
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={selected ? `${selected.code ?? ''} ${selected.label}`.trim() : placeholder}
            className="w-full border-0 p-0 text-sm focus:ring-0"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHighlight((h) => Math.min(h + 1, filtered.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHighlight((h) => Math.max(h - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const option = filtered[highlight];
                if (option) commit(option);
              } else if (e.key === 'Escape') {
                setOpen(false);
                setQuery('');
              } else if (e.key === 'Tab') {
                // Tabbing away selects the highlighted option: the behaviour
                // someone typing "5020" then Tab expects.
                const option = filtered[highlight];
                if (option && query.trim()) commit(option);
              }
            }}
          />
        ) : (
          <span
            className={clsx('min-w-0 flex-1 truncate text-sm', selected ? 'text-navy-900' : 'text-slate-400')}
          >
            {selected ? (
              <>
                {selected.code && <span className="font-mono text-xs text-slate-500">{selected.code} </span>}
                {selected.label}
              </>
            ) : (
              placeholder
            )}
          </span>
        )}

        {allowClear && selected && !disabled && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChange(null, null);
              setQuery('');
            }}
            className="shrink-0 rounded p-0.5 text-slate-400 hover:text-slate-700"
            aria-label="Clear"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        )}

        <svg className="h-4 w-4 shrink-0 text-slate-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path
            fillRule="evenodd"
            d="M5.22 8.22a.75.75 0 011.06 0L10 11.94l3.72-3.72a.75.75 0 111.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L5.22 9.28a.75.75 0 010-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </div>

      {open && (
        <ul
          ref={listRef}
          className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-slate-200 bg-white py-1 shadow-raised"
          role="listbox"
        >
          {loading ? (
            <li className="px-3 py-2 text-sm text-slate-500">Loading...</li>
          ) : filtered.length === 0 ? (
            <li className="px-3 py-2 text-sm text-slate-500">{emptyMessage}</li>
          ) : (
            filtered.map((option, i) => (
              <li
                key={option.value}
                role="option"
                aria-selected={option.value === value}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => commit(option)}
                className={clsx(
                  'cursor-pointer px-3 py-1.5',
                  i === highlight && 'bg-brand-50',
                  option.disabled && 'cursor-not-allowed opacity-50',
                )}
              >
                <div className="flex items-baseline gap-2">
                  {option.code && (
                    <span className="shrink-0 font-mono text-xs text-slate-500">{option.code}</span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm text-navy-900">{option.label}</span>
                </div>
                {option.detail && <p className="truncate text-2xs text-slate-500">{option.detail}</p>}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
