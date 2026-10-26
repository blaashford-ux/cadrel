/** Where the module views sit inside the window. The rail is the shell's own page on the left; a module fills the rest. */
export const RAIL_WIDTH = 64;

export interface Size {
  width: number;
  height: number;
}
export interface Rect extends Size {
  x: number;
  y: number;
}

/** The area a module's view occupies, given the window's content size. */
export function moduleBounds(content: Size): Rect {
  return { x: RAIL_WIDTH, y: 0, width: Math.max(0, content.width - RAIL_WIDTH), height: Math.max(0, content.height) };
}
