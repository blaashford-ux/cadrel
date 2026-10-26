/**
 * Removes personal data from a saved Amazon page before anything is written to disk.
 * Rules are documented in docs/capture-fields.md. Script and style bodies are dropped (they hold most
 * ids and tokens and none of the book data) except the blobs the parsers read.
 */
const KEEP_SCRIPT = ['colorImages', 'ImageBlockATF'];

/** Values that identify the signed-in person, discovered from the page itself. */
export function detectPersonalLiterals(html: string): string[] {
  const found = new Set<string>();
  const add = (v: string | undefined) => {
    const t = v?.trim();
    if (t && t.length >= 3 && !t.includes('REDACTED')) found.add(t);
  };
  const pats: RegExp[] = [
    /config\.customerName'\s*,\s*'([^']+)'/g,
    /customerName['"]?\s*[:,]\s*['"]([^'"]+)['"]/g,
    /Deliver to\s+([^<\n]+?)\s*</g,
    /Hello,\s*([^<\n]+?)\s*</g,
    /class="nav-shortened-name">([^<]+)</g,
    /customerId['"]?\s*[:=]\s*['"]([^'"]+)['"]/g,
    /&quot;customerId&quot;:&quot;([^&]+)&quot;/g,
    /[?&;]cid=([A-Z0-9]{8,})/g,
    /data-raw-id="([A-Z0-9]+)"/g,
    /hashCustomerAndSessionId'\s*,\s*'([0-9a-f]+)'/g,
    /id="glow-ingress-line2">\s*([^<]+?)\s*</g,
  ];
  for (const p of pats) for (const m of html.matchAll(p)) add(m[1]);
  return [...found];
}

export function scrub(html: string, extraLiterals: string[] = []): string {
  const literals = [...new Set([...detectPersonalLiterals(html), ...extraLiterals])].sort((a, b) => b.length - a.length);
  let s = html;
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => (KEEP_SCRIPT.some((k) => m.includes(k)) && !m.includes('ue_sid') ? m : '<script></script>'));
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>');
  s = s.replace(/(?<!\d)\d{3,7}-\d{7}-\d{7}(?!\d)/g, (m) => m.replace(/\d/g, '0')); // session ids (3-7-7 digits) and similar client ids (7-7-7); not \b: the id also appears URL-encoded as ...%2F137-...
  s = s.replace(/(encrypted-slate-token' content=')[^']*/g, '$1REDACTED');
  s = s.replace(/((?:anti-csrftoken-a2z|glow-validation-token|csrf[-_]?token)["']?\s*(?:value|content)?\s*=\s*["'])[^"']*/gi, '$1REDACTED');
  s = s.replace(/([?&;](?:sid|cid|rid|session-id|customerId)=)[^&"'\s<]*/g, '$1REDACTED');
  s = s.replace(/(name="(?:glow-validation-token|anti-csrftoken-a2z)"[^>]*value=")[^"]*/g, '$1REDACTED');
  s = s.replace(/((?:anti-csrftoken-a2z|csrfToken)(?:&quot;|")\s*:\s*(?:&quot;|"))[^&"]*/g, '$1REDACTED');
  s = s.replace(/(name="dropdown-selection(?:-ubb)?" type="hidden" value=")[^"]*/g, '$1REDACTED');
  s = s.replace(/(data-acp-params=")[^"]*/g, '$1REDACTED');
  s = s.replace(/(data-request-context=")[^"]*/g, '$1REDACTED');
  s = s.replace(/(Deliver to )[^<]*?(\s*<\/span>)/g, '$1REDACTED$2');
  s = s.replace(/(id="glow-ingress-line2">\s*)[^<]*?(\s*<\/span>)/g, '$1REDACTED$2');
  s = s.replace(/Hello,\s*[^<]*/g, 'Hello, REDACTED');
  s = s.replace(/(<span class="nav-shortened-name">)[^<]*/g, '$1REDACTED');
  s = s.replace(/Get free shipping to [^<]*/g, 'Get free shipping to REDACTED');
  s = s.replace(/(<\/span>\s+to )[A-Z][A-Za-z ]+?(?=\s+on <|<\/div>)/g, '$1REDACTED');
  s = s.replace(/((?:FREE )?[Dd]elivery to )[A-Z][A-Za-z ]+?(?= on <|<)/g, '$1REDACTED');
  for (const lit of literals) s = s.split(lit).join('REDACTED');
  return s;
}
