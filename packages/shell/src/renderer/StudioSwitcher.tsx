import type { StudiosView } from '../shared/api';

const api = window.cadrel.studios;

/** Switches between the Studios this person can use: their own and any they were invited to. */
export function StudioSwitcher({ studios }: { studios: StudiosView }) {
  const active = studios.studios.find((s) => s.id === studios.activeId)!;
  return (
    <div className="studio-switch">
      <label htmlFor="studio-select" className="muted small">Studio</label>
      <select id="studio-select" value={studios.activeId} onChange={(e) => void api.setActive(e.target.value)}>
        {studios.studios.map((s) => (
          <option key={s.id} value={s.id}>{s.name}{s.role === 'member' ? ' (invited)' : ''}</option>
        ))}
      </select>
      <span className="chip">{active.status === 'local' ? 'On this computer' : active.role === 'owner' ? 'You own it' : 'Member'}</span>
    </div>
  );
}
