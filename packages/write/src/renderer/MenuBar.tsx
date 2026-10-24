import { useCallback, useEffect, useRef, useState } from 'react';
import type { MenuNode } from '../shared/api';
import { Icon } from './Icon';

const selectable = (n: MenuNode) => n.type !== 'separator' && n.enabled;

function firstSelectable(items: MenuNode[], from = -1, dir: 1 | -1 = 1): number {
  const n = items.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + dir * k) % n) + n) % n;
    if (selectable(items[i])) return i;
  }
  return -1;
}

/** The items shown at each open level, given the path of highlighted indices (path[0] is the top-level menu). */
function levels(menu: MenuNode[], path: number[]): MenuNode[][] {
  const out: MenuNode[][] = [];
  let items: MenuNode[] | undefined = menu[path[0]]?.submenu;
  for (let d = 1; items; d++) {
    out.push(items);
    const hot = path[d] !== undefined ? items[path[d]] : undefined;
    items = hot?.type === 'submenu' && path.length > d + 1 ? hot.submenu : undefined;
  }
  return out;
}

/** The application menu (File, Edit, …) drawn inside the title bar. Items run through the real native menu. */
export function MenuBar() {
  const [menu, setMenu] = useState<MenuNode[]>([]);
  const [path, setPath] = useState<number[] | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => window.mdedit.getMenu().then(setMenu).catch(() => undefined), []);
  useEffect(() => void refresh(), [refresh]);

  const open = useCallback(
    async (top: number, withFirst = false) => {
      await refresh();
      setPath(withFirst ? [top, 0] : [top]);
    },
    [refresh]
  );
  const close = useCallback(() => setPath(null), []);

  // keyboard: Alt+letter opens a menu; arrows / Enter / Esc drive an open one
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.length === 1) {
        const top = menu.findIndex((m) => m.mnemonic === e.key.toLowerCase());
        if (top >= 0) {
          e.preventDefault();
          e.stopPropagation();
          void open(top, true);
          return;
        }
      }
      if (!path) return;
      const lv = levels(menu, path);
      const items = lv[lv.length - 1] ?? [];
      const d = lv.length; // depth of the deepest open list
      const hot = path[d] !== undefined && path[d] >= 0 ? path[d] : undefined;
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === 'Escape') {
        stop();
        if (path.length > 2) setPath(path.slice(0, -1));
        else close();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        stop();
        const next = firstSelectable(items, hot ?? (e.key === 'ArrowDown' ? -1 : 0), e.key === 'ArrowDown' ? 1 : -1);
        if (next >= 0) setPath([...path.slice(0, d), next]);
      } else if (e.key === 'ArrowRight') {
        stop();
        const item = hot !== undefined ? items[hot] : undefined;
        if (item?.type === 'submenu' && item.submenu) setPath([...path.slice(0, d + 1), Math.max(0, firstSelectable(item.submenu))]);
        else void open((path[0] + 1) % menu.length, true);
      } else if (e.key === 'ArrowLeft') {
        stop();
        if (path.length > 2) setPath(path.slice(0, -1));
        else void open((path[0] - 1 + menu.length) % menu.length, true);
      } else if (e.key === 'Enter' || e.key === ' ') {
        stop();
        const item = hot !== undefined ? items[hot] : undefined;
        if (!item) return;
        if (item.type === 'submenu' && item.submenu) setPath([...path.slice(0, d + 1), Math.max(0, firstSelectable(item.submenu))]);
        else activate(item);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, path, open, close]);

  // click outside / losing focus closes it
  useEffect(() => {
    if (!path) return;
    const down = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('blur', close);
    };
  }, [path, close]);

  const activate = (item: MenuNode) => {
    close();
    window.mdedit.clickMenu(item.id);
  };

  const renderList = (items: MenuNode[], d: number): JSX.Element => (
    <div className="mb-list" role="menu" style={d > 1 ? undefined : undefined}>
      {items.map((it, i) => {
        if (it.type === 'separator') return <div key={it.id} className="mb-sep" role="separator" />;
        const isHot = path?.[d] === i;
        const sub = it.type === 'submenu';
        const subOpen = sub && isHot && (path?.length ?? 0) > d + 1;
        return (
          <div key={it.id} className="mb-item-wrap">
            <button
              type="button"
              role={it.type === 'checkbox' ? 'menuitemcheckbox' : it.type === 'radio' ? 'menuitemradio' : 'menuitem'}
              aria-checked={it.type === 'checkbox' || it.type === 'radio' ? !!it.checked : undefined}
              aria-haspopup={sub || undefined}
              aria-expanded={sub ? subOpen : undefined}
              className={'mb-item' + (isHot ? ' hot' : '')}
              disabled={!it.enabled}
              onMouseMove={() => {
                // (move, not enter: a menu that appears under a still pointer must not steal the highlight)
                if (!path || !it.enabled || (path[d] === i && (!sub || path.length > d + 1))) return;
                setPath([...path.slice(0, d), i, ...(sub ? [-1] : [])]);
              }}
              onClick={() => (sub ? setPath([...(path ?? []).slice(0, d), i, -1]) : activate(it))}
            >
              <span className="mb-check">{it.checked ? <Icon name="check" size={13} /> : null}</span>
              <span className="mb-label">{it.label}</span>
              {it.hint && <span className="mb-hint">{it.hint}</span>}
              {sub && <Icon name="right" size={13} className="mb-sub" />}
            </button>
            {subOpen && it.submenu && <div className="mb-flyout">{renderList(it.submenu, d + 1)}</div>}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="menubar" role="menubar" ref={root} onMouseDown={(e) => e.preventDefault()}>
      {menu.map((m, i) => (
        <div key={m.id} className="mb-top-wrap">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={path?.[0] === i}
            className={'mb-top' + (path?.[0] === i ? ' open' : '')}
            onClick={() => (path?.[0] === i ? close() : void open(i))}
            onMouseEnter={() => path && path[0] !== i && void open(i)}
          >
            {m.label}
          </button>
          {path?.[0] === i && m.submenu && <div className="mb-drop">{renderList(m.submenu, 1)}</div>}
        </div>
      ))}
    </div>
  );
}
