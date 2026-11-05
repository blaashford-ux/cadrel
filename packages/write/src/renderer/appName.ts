/** What this app is called on screen: Cadrel Reader when the window is Reader's, otherwise Cadrel Write. */
export function appName(): string {
  return typeof window !== 'undefined' && window.cadrelWrite?.capabilities?.reader ? 'Cadrel Reader' : 'Cadrel Write';
}
