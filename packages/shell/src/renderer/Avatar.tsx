import { useEffect, useState } from 'react';

const api = window.cadrel.user;

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

/** The user's photo, or their initials until there is one. Follows changes made anywhere in the app. */
export function Avatar({ size = 32 }: { size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const [name, setName] = useState('');
  useEffect(() => {
    let live = true;
    const load = (n?: string) => {
      if (n !== undefined) setName(n);
      void api.avatar().then((s) => live && setSrc(s), () => undefined);
    };
    void api.get().then((v) => live && load(v.name), () => undefined);
    const off = api.onChange((v) => load(v.name));
    return () => {
      live = false;
      off();
    };
  }, []);
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4 }} role="img" aria-label={name || 'You'}>
      {src ? <img src={src} alt="" /> : initials(name)}
    </span>
  );
}
