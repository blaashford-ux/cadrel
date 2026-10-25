export const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
export const money = (n: number, c: string) => (c === 'USD' ? usd(n) : `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${c}`);
export const int = (n: number) => Math.round(n).toLocaleString('en-US');
export const pct = (n: number) => `${(n * 100).toFixed(n > 0 && n < 0.1 ? 1 : 0)}%`;

export const currentMonth = () => new Date().toISOString().slice(0, 7);

export function shiftMonth(m: string, by: number): string {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, mo - 1 + by, 1)).toISOString().slice(0, 7);
}

export function monthName(m: string): string {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export const shortMonth = (m: string) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1, 1)).toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });

export const quarterOf = (m: string) => `${m.slice(0, 4)}-Q${Math.floor((+m.slice(5, 7) - 1) / 3) + 1}`;

export type PeriodKind = 'month' | 'quarter' | 'year' | 'custom';

/** The first and last month of a month ('2026-09'), quarter ('2026-Q3'), year ('2026') or custom ('2026-03..2026-05') period. */
export function periodRange(kind: PeriodKind, value: string): { from: string; to: string } | null {
  if (kind === 'month' && /^\d{4}-\d{2}$/.test(value)) return { from: value, to: value };
  const q = /^(\d{4})-Q([1-4])$/.exec(value);
  if (kind === 'quarter' && q) { const s = (+q[2]! - 1) * 3 + 1; return { from: `${q[1]}-${String(s).padStart(2, '0')}`, to: `${q[1]}-${String(s + 2).padStart(2, '0')}` }; }
  if (kind === 'year' && /^\d{4}$/.test(value)) return { from: `${value}-01`, to: `${value}-12` };
  const c = /^(\d{4}-\d{2})\.\.(\d{4}-\d{2})$/.exec(value);
  if (kind === 'custom' && c && c[1]! <= c[2]!) return { from: c[1]!, to: c[2]! };
  return null;
}

/** The shortcuts offered above the period pickers: the period they mean today. */
export function periodShortcuts(now = currentMonth()): { label: string; kind: PeriodKind; value: string }[] {
  const y = now.slice(0, 4);
  const lastQ = quarterOf(shiftMonth(now, -3));
  return [
    { label: 'Last month', kind: 'month', value: shiftMonth(now, -1) },
    { label: 'This quarter', kind: 'quarter', value: quarterOf(now) },
    { label: 'Last quarter', kind: 'quarter', value: lastQ },
    { label: 'This year', kind: 'year', value: y },
    { label: 'Last year', kind: 'year', value: String(+y - 1) },
  ];
}

export const SOURCE_NAME = { ebook: 'eBook', print: 'Print', kenp: 'Kindle+' } as const;
