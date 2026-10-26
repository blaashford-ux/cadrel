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
export function Avatar({ size = 32, onClick, title }: { size?: number; onClick?: () => void; title?: string }) {
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
  const face = src ? <img src={src} alt="" /> : initials(name);
  const style = { width: size, height: size, fontSize: size * 0.4 };
  if (!onClick) return <span className="avatar" style={style} role="img" aria-label={name || 'You'}>{face}</span>;
  // Clickable: choosing a picture here is how a person sets their photo.
  return (
    <button type="button" className="avatar clickable" style={style} onClick={onClick} title={title ?? 'Choose your photo'} aria-label="Choose your photo">
      {face}
      <span className="avatar-hint" aria-hidden>Change</span>
    </button>
  );
}
