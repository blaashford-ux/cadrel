/**
 * Which working view a person's Home and Dashboard lead with. A lens is derived from what their roles hold, never stored, so it cannot disagree
 * with their access; it only chooses what to show first. The order is the order of reach: the first lens is the person's default, and a person
 * with several may switch between them.
 *
 *   director  oversees the Studio: may manage roles (Owner, Admin), or approves editorial work without running it (Director, Series Lead)
 *   editor    runs editorial passes (edit.run)
 *   author    writes manuscripts (manuscript.write)
 *
 * A role that holds none of these (Marketing, Finance, Guest ...) has no lens and sees Home and the Dashboard as they always were.
 */
export const LENSES = ['director', 'editor', 'author'] as const;
export type Lens = (typeof LENSES)[number];

export interface LensCapabilities {
  rolesManage: boolean;
  editApprove: boolean;
  editRun: boolean;
  manuscriptWrite: boolean;
}

export function lensesFor(c: LensCapabilities): Lens[] {
  const out: Lens[] = [];
  if (c.rolesManage || (c.editApprove && !c.editRun)) out.push('director');
  if (c.editRun) out.push('editor');
  if (c.manuscriptWrite) out.push('author');
  return out;
}

/** The capabilities `lensesFor` looks at, by the names the permission engine uses. */
export const LENS_CAPABILITIES = { rolesManage: 'roles.manage', editApprove: 'edit.approve', editRun: 'edit.run', manuscriptWrite: 'manuscript.write' } as const satisfies Record<keyof LensCapabilities, string>;
