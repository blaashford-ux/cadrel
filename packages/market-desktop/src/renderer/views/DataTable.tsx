import { useMemo, useState, type ReactNode } from 'react';

export interface Column<T> {
  key: string;
  label: string;
  /** Right-aligned figures; filtered with a number expression instead of text. */
  num?: boolean;
  /** A fixed set of values, filtered with a drop-down. */
  choices?: string[];
  /** For a drop-down column whose cell can hold several values (the names of a collaboration): a row matches a choice if any of these is it. `get` still gives the text that sorts. */
  values?: (row: T) => string[];
  /** The value sorted and filtered on; null means "blank". */
  get: (row: T) => string | number | null;
  render?: (row: T) => ReactNode;
  title?: (row: T) => string | undefined;
}

type Test = (v: number | null) => boolean;

/**
 * Number filters: `150` (equals), `>100`, `>=100`, `<5`, `<=5`, `10-50` or `10..50` (inclusive), `blank`.
 * Returns null when the text is not one of those, so the box can flag it instead of silently showing nothing.
 */
export function parseNumberFilter(text: string): Test | null {
  const t = text.trim().toLowerCase().replace(/,/g, '');
  if (!t) return () => true;
  if (t === 'blank' || t === 'none') return (v) => v == null;
  const num = '(-?\\d+(?:\\.\\d+)?)';
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`^(>=|<=|>|<|=)?\\s*${num}$`).exec(t))) {
    const n = Number(m[2]);
    const op = m[1] ?? '=';
    return (v) => v != null && (op === '>' ? v > n : op === '<' ? v < n : op === '>=' ? v >= n : op === '<=' ? v <= n : v === n);
  }
  if ((m = new RegExp(`^${num}\\s*(?:-|\\.\\.|to)\\s*${num}$`).exec(t))) {
    const lo = Math.min(Number(m[1]), Number(m[2])), hi = Math.max(Number(m[1]), Number(m[2]));
    return (v) => v != null && v >= lo && v <= hi;
  }
  return null;
}

type Sort = { key: string; dir: 'asc' | 'desc' } | null;

/** A table whose every column can be sorted (click the heading: ascending, descending, off) and filtered (the box under it). */
export function DataTable<T>({ rows, columns, rowKey, rowProps, empty, noun = 'book' }: { rows: T[]; columns: Column<T>[]; rowKey: (r: T) => string; rowProps?: (r: T) => Record<string, string>; empty?: string; /** What a row is, for the count line. */ noun?: string }) {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<Sort>(null);

  const shown = useMemo(() => {
    const tests = columns.map((c) => {
      const f = (filters[c.key] ?? '').trim();
      if (!f) return null;
      if (c.num) {
        const t = parseNumberFilter(f);
        return t ? (r: T) => t(typeof c.get(r) === 'number' ? (c.get(r) as number) : null) : null;
      }
      if (c.choices) return c.values ? (r: T) => (f === '' ? true : c.values!(r).includes(f)) : (r: T) => String(c.get(r) ?? '') === f;
      const q = f.toLowerCase();
      return (r: T) => String(c.get(r) ?? '').toLowerCase().includes(q);
    });
    let out = rows.filter((r) => tests.every((t) => !t || t(r)));
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col) {
        const sgn = sort.dir === 'asc' ? 1 : -1;
        out = [...out].sort((a, b) => {
          const x = col.get(a), y = col.get(b);
          if (x == null && y == null) return 0;
          if (x == null) return 1; // blanks stay last either way
          if (y == null) return -1;
          return sgn * (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' }));
        });
      }
    }
    return out;
  }, [rows, columns, filters, sort]);

  const cycle = (key: string) => setSort((s) => (!s || s.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null));
  const active = Object.values(filters).some((v) => v.trim());

  return (
    <>
      <div className="muted" role="status">
        {shown.length === rows.length ? `${rows.length} ${noun}${rows.length === 1 ? '' : 's'}` : `${shown.length} of ${rows.length} ${noun}s`}
        {(active || sort) && <> · <button className="link" onClick={() => { setFilters({}); setSort(null); }}>Clear filters and sorting</button></>}
      </div>
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.num ? 'num' : undefined} aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                <button className="link sortbtn" onClick={() => cycle(c.key)} title="Sort by this column">
                  {c.label}{sort?.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                </button>
              </th>
            ))}
          </tr>
          <tr className="filters">
            {columns.map((c) => {
              const v = filters[c.key] ?? '';
              const set = (x: string) => setFilters((f) => ({ ...f, [c.key]: x }));
              return (
                <th key={c.key} className={c.num ? 'num' : undefined}>
                  {c.choices ? (
                    <select value={v} onChange={(e) => set(e.target.value)} aria-label={`Filter ${c.label}`}>
                      <option value="">All</option>
                      {c.choices.map((x) => <option key={x} value={x}>{x || 'none'}</option>)}
                    </select>
                  ) : (
                    <input
                      value={v} onChange={(e) => set(e.target.value)} aria-label={`Filter ${c.label}`}
                      placeholder={c.num ? '>100, 10-50' : 'contains'}
                      aria-invalid={c.num && !!v.trim() && !parseNumberFilter(v)}
                      title={c.num ? 'A number, >n, <n, >=n, <=n, a range like 10-50, or "blank"' : 'Rows whose text contains this'}
                    />
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={rowKey(r)} {...(rowProps?.(r) ?? {})}>
              {columns.map((c) => <td key={c.key} className={c.num ? 'num' : c.key === 'text' ? 'muted' : undefined} title={c.title?.(r)}>{c.render ? c.render(r) : (c.get(r) ?? '')}</td>)}
            </tr>
          ))}
          {shown.length === 0 && <tr><td colSpan={columns.length} className="muted">{empty ?? 'Nothing matches the filters.'}</td></tr>}
        </tbody>
      </table>
    </>
  );
}
