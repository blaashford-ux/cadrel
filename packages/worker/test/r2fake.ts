/** An R2 bucket in memory: the parts of its API the Worker uses. */
export function fakeR2(): R2Bucket & { keys(): string[] } {
  const m = new Map<string, Uint8Array>();
  return {
    async head(k: string) {
      return m.has(k) ? ({ key: k, size: m.get(k)!.length } as R2Object) : null;
    },
    async put(k: string, v: ArrayBuffer | Uint8Array | string) {
      m.set(k, typeof v === 'string' ? new TextEncoder().encode(v) : new Uint8Array(v as ArrayBuffer));
      return {} as R2Object;
    },
    async get(k: string) {
      const b = m.get(k);
      return b ? ({ key: k, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) } as unknown as R2ObjectBody) : null;
    },
    async list(o: { prefix?: string; limit?: number; cursor?: string } = {}) {
      const all = [...m.keys()].filter((k) => k.startsWith(o.prefix ?? '')).sort();
      const from = o.cursor ? all.findIndex((k) => k > o.cursor!) : 0;
      const rest = from < 0 ? [] : all.slice(from);
      const page = rest.slice(0, o.limit ?? 1000);
      const truncated = rest.length > page.length;
      return { objects: page.map((k) => ({ key: k, size: m.get(k)!.length })), truncated, cursor: truncated ? page[page.length - 1] : undefined };
    },
    keys: () => [...m.keys()]
  } as unknown as R2Bucket & { keys(): string[] };
}
