/** Split one CSV line on `delim`, honouring double quotes ("" is a literal quote). */
export function splitCsvLine(line: string, delim = ','): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** The delimiter a header line uses: whichever of comma, tab or semicolon it has most of. */
export function sniffDelimiter(header: string): string {
  const n = (d: string) => header.split(d).length - 1;
  return [',', '\t', ';'].reduce((best, d) => (n(d) > n(best) ? d : best), ',');
}
