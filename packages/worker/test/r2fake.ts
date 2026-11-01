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
    keys: () => [...m.keys()]
  } as unknown as R2Bucket & { keys(): string[] };
}
