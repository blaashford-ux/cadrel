import { unzipSync, strFromU8 } from 'fflate';
import { splitCsvLine, sniffDelimiter } from '../csv.js';

export type Grid = string[][];

// ---------------------------------------------------------------- reading files

const colIndex = (ref: string) => {
  let n = 0;
  for (const ch of ref.replace(/[^A-Z]/gi, '').toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
};
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** The sheets of an .xlsx workbook as grids of text. Dates stored as numbers come out as their serial number. */
export function readXlsx(bytes: Uint8Array): { name: string; rows: Grid }[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('that file is not a readable .xlsx workbook');
  }
  const text = (p: string) => (files[p] ? strFromU8(files[p]!) : '');
  const shared: string[] = [];
  for (const m of text('xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    shared.push(unxml([...m[1]!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  }
  const rels = new Map<string, string>();
  for (const m of text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) rels.set(id, target.replace(/^\/?(?:xl\/)?/, 'xl/'));
  }
  const out: { name: string; rows: Grid }[] = [];
  for (const m of text('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)) {
    const name = unxml(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? '');
    const rid = /\br:id="([^"]+)"/.exec(m[0])?.[1];
    const xml = rid && rels.get(rid) ? text(rels.get(rid)!) : '';
    if (!xml) continue;
    const rows: Grid = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row: string[] = [];
      for (const c of r[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1]!;
        const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
        if (!ref) continue;
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
        const body = c[2] ?? '';
        let v = '';
        if (type === 's') v = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1])] ?? '';
        else if (type === 'inlineStr') v = unxml([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
        else v = unxml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
        row[colIndex(ref)] = v.trim();
      }
      rows.push(Array.from(row, (x) => x ?? ''));
    }
    out.push({ name, rows });
  }
  return out;
}

export function readCsv(text: string): Grid {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const d = sniffDelimiter(lines.find((l) => l.split(/[,;\t]/).length > 2) ?? lines[0]!);
  return lines.map((l) => splitCsvLine(l, d));
}

export const isXlsx = (name: string, bytes: Uint8Array) => /\.xlsx$/i.test(name) || (bytes[0] === 0x50 && bytes[1] === 0x4b);

// ---------------------------------------------------------------- reading values

export const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function findHeader(rows: Grid, want: Record<string, string[]>): { row: number; cols: Record<string, number> } | null {
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const heads = rows[i]!.map(norm);
    const cols: Record<string, number> = {};
    for (const [key, names] of Object.entries(want)) {
      const j = names.map((n) => heads.indexOf(n)).find((x) => x >= 0);
      if (j !== undefined) cols[key] = j;
    }
    if (Object.keys(want).filter((k) => !k.endsWith('?')).every((k) => k in cols)) return { row: i, cols };
  }
  return null;
}

const iso = (y: number, m: number, d: number) => (y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);

/** Dates in a column, as YYYY-MM-DD. Handles ISO, Excel serial numbers, month names, and m/d/y or d/m/y (decided from the whole column). */
export function parseDates(values: string[]): (string | null)[] {
  const slash = values.map((v) => /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(v));
  const dmy = slash.some((m) => m && Number(m[1]) > 12);
  return values.map((v, i) => {
    const t = v.trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
    if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
    if (/^\d{5}(\.\d+)?$/.test(t) && +t > 30000 && +t < 80000) return new Date(Math.round((+t - 25569) * 86400000)).toISOString().slice(0, 10);
    m = slash[i] ?? null;
    if (m) return dmy ? iso(+m[3]!, +m[2]!, +m[1]!) : iso(+m[3]!, +m[1]!, +m[2]!);
    const ms = Date.parse(`${t} UTC`);
    return Number.isNaN(ms) || !/[a-z]{3}/i.test(t) ? null : new Date(ms).toISOString().slice(0, 10);
  });
}

/** An optional text column as a one-key object, or nothing when the cell is empty. */
export const cell = <K extends string>(r: string[], i: number | undefined, key: K): { [P in K]?: string } => {
  const v = i === undefined ? '' : (r[i] ?? '').trim();
  return v ? ({ [key]: v } as { [P in K]?: string }) : {};
};

export const num = (v: string | undefined) => {
  const n = Number((v ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

