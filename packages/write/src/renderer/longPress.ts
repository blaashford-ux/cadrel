import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react';

/**
 * Press-and-hold for touch screens. The phone's own long-press menu (and the `contextmenu` event it
 * raises) is unreliable inside a WebView, so touch and pen are timed here and the app's own menu is
 * opened directly. Mouse right-click still arrives through `contextmenu`.
 */
const HOLD_MS = 450;
const SLOP = 8; // px of finger movement that turns a hold into a scroll

let timer = 0;
let origin = { x: 0, y: 0 };
let lastFired = 0;

function cancel() {
  window.clearTimeout(timer);
  timer = 0;
}

/** True just after a long press opened a menu, so the click that follows the release can be ignored. */
export function justLongPressed(): boolean {
  return Date.now() - lastFired < 600;
}

export function longPressProps(open: (x: number, y: number, target: HTMLElement) => void, accept: (target: HTMLElement) => boolean = () => true) {
  return {
    onPointerDown(e: ReactPointerEvent<HTMLElement>) {
      cancel();
      const target = e.target as HTMLElement;
      if (e.pointerType === 'mouse' || !e.isPrimary || !accept(target)) return;
      origin = { x: e.clientX, y: e.clientY };
      const { clientX: x, clientY: y } = e;
      timer = window.setTimeout(() => {
        timer = 0;
        lastFired = Date.now();
        open(x, y, target);
      }, HOLD_MS);
    },
    onPointerMove(e: ReactPointerEvent<HTMLElement>) {
      if (timer && Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > SLOP) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu(e: ReactMouseEvent<HTMLElement>) {
      const target = e.target as HTMLElement;
      if (!accept(target)) return;
      e.preventDefault(); // never let the system menu cover ours
      // A touch long-press already opened the menu from the timer; otherwise (mouse, keyboard) open it now.
      if (!justLongPressed()) {
        cancel();
        open(e.clientX, e.clientY, target);
      }
    }
  };
}
