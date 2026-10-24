import { useEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick(): void;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose(): void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
  const [index, setIndex] = useState(enabled[0] ?? -1);
  const [pos, setPos] = useState({ x, y });

  // Keep the menu on screen.
  useEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
  }, [x, y]);

  useEffect(() => {
    ref.current?.focus();
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const step = (d: 1 | -1) => {
    if (enabled.length === 0) return;
    const at = enabled.indexOf(index);
    setIndex(enabled[(at + d + enabled.length) % enabled.length]);
  };

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
        else if (e.key === 'ArrowDown') step(1);
        else if (e.key === 'ArrowUp') step(-1);
        else if (e.key === 'Enter' && items[index] && !items[index].disabled) {
          const it = items[index];
          onClose();
          it.onClick();
        } else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {items.map((it, i) => (
        <button
          key={it.label}
          role="menuitem"
          disabled={it.disabled}
          className={(it.danger ? 'danger ' : '') + (i === index ? 'hot' : '')}
          onMouseEnter={() => !it.disabled && setIndex(i)}
          onClick={() => {
            onClose();
            it.onClick();
          }}
        >
          <span>{it.label}</span>
          {it.hint && <span className="hint">{it.hint}</span>}
        </button>
      ))}
    </div>
  );
}
