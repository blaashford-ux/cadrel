/**
 * Record ids: UUIDv7, so they sort by creation time and can be made anywhere (the app, the Worker) without asking a server.
 * Runtime-neutral: only `crypto.getRandomValues`, which Node, Electron and Workers all have.
 */
export function newRecordId(now: number = Date.now()): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  // 48-bit millisecond timestamp, then version 7 and variant bits over the random bytes
  const t = BigInt(Math.max(0, Math.floor(now)));
  for (let i = 0; i < 6; i++) b[i] = Number((t >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const isId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
