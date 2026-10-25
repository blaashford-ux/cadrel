import type { StudioEntry } from '../shared/api';

const WHY: Record<string, string> = {
  'not-provisioned': 'It has not been built in Cloudflare yet. An administrator does that in Admin → Studio Manager.',
  provisioning: 'It is being built in Cloudflare.',
  error: 'Its last set-up failed. Details are in Admin → Studio Manager.',
  ready: 'Cadrel is not connected to it in this build yet.'
};

/** Shown instead of a page's data when the active Studio has none here: never another Studio's data under this Studio's name. */
export function NotConnected({ studio }: { studio: StudioEntry }) {
  return (
    <section className="card" role="status" aria-labelledby="nc-title">
      <h3 id="nc-title">{studio.name} is not connected yet</h3>
      <p className="muted">{WHY[studio.status] ?? WHY.ready}</p>
      <p className="muted small">Pick another Studio from the Studio menu on Home. Nothing from your other Studios is shown here.</p>
    </section>
  );
}
