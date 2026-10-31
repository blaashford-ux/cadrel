import { useCallback, useEffect, useMemo, useState } from 'react';
import { CONDITION_KINDS, STAGE_CATEGORIES, PROJECT_LEVELS, newStageKey, type Condition, type ConditionKind, type WorkflowDraft, type WorkflowRecord } from '@cadrel/kernel';
import type { WorkflowState } from '../shared/api';

const api = window.cadrel.workflow;
type Ready = Extract<WorkflowState, { available: true }>;
const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const CATEGORY_LABEL: Record<(typeof STAGE_CATEGORIES)[number], string> = { start: 'Start', active: 'In progress', review: 'In review', done: 'Done', hold: 'On hold' };

/** One stage in the draft. `key` is set for a stage that exists (or one this draft has named); it never changes once made. */
interface DraftStage { key: string; name: string; category: string; color: string; isNew: boolean }
interface DraftMove { from: string; to: string; roleIds: string[]; conditions: Condition[] }
interface Draft { name: string; description: string; stages: DraftStage[]; moves: DraftMove[]; moveProjects: Record<string, string> }

const toDraft = (w: WorkflowRecord): Draft => ({
  name: w.name, description: w.description, moveProjects: {},
  stages: w.stages.map((s) => ({ key: s.key, name: s.name, category: s.category, color: s.color, isNew: false })),
  moves: w.transitions.map((t) => ({ from: t.from, to: t.to, roleIds: [...t.roleIds], conditions: t.conditions.map((c) => ({ ...c })) }))
});
/** Stages belong to Books (a Project has none), so only the "subproject" default is used: it is the default for new Books. */
const defaultLabel = (levels: string[]) => (levels.includes('subproject') ? 'default for new books' : 'default for projects (not used: projects have no stage)');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Builds workflows: the stages a project moves through, which stage can move to which, and the gate on each move (who may make it and what must be true of the project). */
export function WorkflowBuilder() {
  const [s, setS] = useState<WorkflowState | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => api.state().then((v) => { setS(v); return v; }, (e) => { setError(clean(e)); return null; }), []);
  useEffect(() => { void load().then((v) => v && v.available && setPick((p) => p ?? v.workflows.find((w) => w.defaultFor.includes('project'))?.id ?? v.workflows[0]?.id ?? null)); }, [load]);

  const act = useCallback(async <T,>(job: () => Promise<T>, saved?: string): Promise<T | undefined> => {
    setError(null);
    setNote(null);
    try {
      const v = await job();
      await load();
      if (saved) setNote(saved);
      return v;
    } catch (e) {
      setError(clean(e));
      return undefined;
    }
  }, [load]);

  if (!s) return <section className="card"><p className="muted">Loading…</p></section>;
  if (!s.available) return <section className="card" aria-labelledby="wf-title"><h3 id="wf-title">Workflows</h3><p className="muted">{s.reason}</p></section>;
  const w = s.workflows.find((x) => x.id === pick) ?? null;

  return (
    <section className="card workflow-builder" aria-labelledby="wf-title">
      <div className="card-head"><h3 id="wf-title">Workflows</h3></div>
      <p className="muted small">
        A workflow is the list of stages a project moves through. Each move from one stage to another can have a gate: who may make it, and what must be true of the project first. Projects and subprojects each have their own default workflow, so a series can use a different one from its books. Whoever creates a project picks its workflow then; it can’t be changed afterwards.
        {!s.may && ' You can see the workflows here; building them needs the workflow design permission.'}
      </p>
      {error && <div className="banner error" role="alert">{error} <button type="button" className="link" onClick={() => setError(null)}>Dismiss</button></div>}
      {note && <div className="banner info" role="status">{note}</div>}
      <div className="pr-cols">
        <div>
          <ul className="plain pr-list" aria-label="Workflows">
            {s.workflows.map((x) => (
              <li key={x.id}>
                <button type="button" className={`link grow-text${x.id === pick ? ' on' : ''}`} aria-pressed={x.id === pick} onClick={() => setPick(x.id)}>{x.name}</button>
                {x.defaultFor.length > 0 && <span className="chip">{defaultLabel(x.defaultFor)}</span>}
                <span className="muted small" title="Projects using this workflow">{s.usage[x.id]?.projects ?? 0}</span>
              </li>
            ))}
          </ul>
          {s.may && <NewWorkflow workflows={s.workflows} act={act} onMade={setPick} />}
        </div>
        {w ? <Editor key={w.id} w={w} s={s} act={act} onPick={setPick} /> : <p className="muted">Choose a workflow.</p>}
      </div>
    </section>
  );
}

type Act = <T>(job: () => Promise<T>, saved?: string) => Promise<T | undefined>;

function NewWorkflow({ workflows, act, onMade }: { workflows: WorkflowRecord[]; act: Act; onMade: (id: string) => void }) {
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  return (
    <form className="pr-add" onSubmit={(e) => { e.preventDefault(); void act(() => api.create({ name, copyFrom: from || undefined })).then((r) => { if (r) { onMade(r.id); setName(''); setFrom(''); } }); }}>
      <input aria-label="New workflow name" placeholder="New workflow" value={name} onChange={(e) => setName(e.target.value)} />
      <select aria-label="Start from" value={from} onChange={(e) => setFrom(e.target.value)}>
        <option value="">Start from a blank workflow</option>
        {workflows.map((x) => <option key={x.id} value={x.id}>Start from a copy of {x.name}</option>)}
      </select>
      <button type="submit" disabled={!name.trim()}>Create</button>
    </form>
  );
}

function Editor({ w, s, act, onPick }: { w: WorkflowRecord; s: Ready; act: Act; onPick: (id: string | null) => void }) {
  const original = useMemo(() => toDraft(w), [w]);
  const [d, setD] = useState<Draft>(original);
  const [gate, setGate] = useState<string | null>(null);
  useEffect(() => setD(original), [original]);
  const dirty = !same(d, original);
  const editable = s.may;
  const keys = d.stages.map((x) => x.key);
  const removed = original.stages.filter((x) => !keys.includes(x.key));
  const moveOf = (from: string, to: string) => d.moves.find((m) => m.from === from && m.to === to);

  const setStage = (i: number, patch: Partial<DraftStage>) => {
    const cur = d.stages[i]!;
    // a stage that has not been saved yet takes its key from its name as it is typed, so the key it is saved with matches what it is called;
    // moves that already name it follow. A saved stage keeps its key for good (renaming must move no book).
    if (cur.isNew && patch.name !== undefined && patch.name !== cur.name) {
      const key = newStageKey(patch.name, [...d.stages.filter((_, j) => j !== i).map((x) => x.key), ...original.stages.map((x) => x.key)]);
      const was = cur.key;
      setD({
        ...d,
        stages: d.stages.map((x, j) => (j === i ? { ...x, ...patch, key } : x)),
        moves: d.moves.map((m) => ({ ...m, from: m.from === was ? key : m.from, to: m.to === was ? key : m.to }))
      });
      return;
    }
    setD({ ...d, stages: d.stages.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  };
  const addStage = () => {
    const name = `Stage ${d.stages.length + 1}`;
    setD({ ...d, stages: [...d.stages, { key: newStageKey(name, [...keys, ...original.stages.map((x) => x.key)]), name, category: 'active', color: '', isNew: true }] });
  };
  const removeStage = (i: number) => {
    const gone = d.stages[i]!;
    setD({ ...d, stages: d.stages.filter((_, j) => j !== i), moves: d.moves.filter((m) => m.from !== gone.key && m.to !== gone.key) });
  };
  const shift = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= d.stages.length) return;
    const next = [...d.stages];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setD({ ...d, stages: next });
  };
  const toggleMove = (from: string, to: string, on: boolean) => setD({ ...d, moves: on ? [...d.moves, { from, to, roleIds: [], conditions: [] }] : d.moves.filter((m) => !(m.from === from && m.to === to)) });
  const setMove = (from: string, to: string, patch: Partial<DraftMove>) => setD({ ...d, moves: d.moves.map((m) => (m.from === from && m.to === to ? { ...m, ...patch } : m)) });
  const everyMove = () => setD({ ...d, moves: d.stages.flatMap((a) => d.stages.filter((b) => b.key !== a.key).map((b) => moveOf(a.key, b.key) ?? { from: a.key, to: b.key, roleIds: [], conditions: [] })) });
  const oneStep = () => setD({ ...d, moves: d.stages.flatMap((a, i) => [d.stages[i + 1], d.stages[i - 1]].filter((b): b is DraftStage => !!b).map((b) => moveOf(a.key, b.key) ?? { from: a.key, to: b.key, roleIds: [], conditions: [] })) });

  const save = () => {
    const draft: WorkflowDraft = {
      name: d.name, description: d.description,
      stages: d.stages.map((x) => ({ key: x.key, name: x.name, category: x.category, color: x.color })),
      transitions: d.moves.filter((m) => keys.includes(m.from) && keys.includes(m.to)),
      moveProjects: Object.fromEntries(removed.filter((x) => (s.usage[w.id]?.byStage[x.key] ?? 0) > 0).map((x) => [x.key, d.moveProjects[x.key] || d.stages[0]?.key || '']))
    };
    void act(() => api.save(w.id, draft), 'Saved. Projects keep their stage unless it was removed.');
  };

  const gateSummary = (m: DraftMove) => {
    const bits = [...(m.roleIds.length ? [m.roleIds.map((r) => s.roles.find((x) => x.id === r)?.name ?? r).join(' or ')] : []), ...(m.conditions.length ? [`${m.conditions.length} condition${m.conditions.length === 1 ? '' : 's'}`] : [])];
    return bits.join(' · ');
  };

  return (
    <div className="pr-detail">
      <h4>{w.name} {w.defaultFor.length > 0 && <span className="chip">{defaultLabel(w.defaultFor)}</span>}</h4>
      <div className="wf-flow" aria-label="Stages in order">
        {d.stages.map((x, i) => <span key={x.key} className="wf-chip" style={x.color ? { borderColor: x.color, color: x.color } : undefined}>{x.name}{i < d.stages.length - 1 ? ' →' : ''}</span>)}
      </div>
      <div className="row">
        <input aria-label="Workflow name" value={d.name} disabled={!editable} onChange={(e) => setD({ ...d, name: e.target.value })} />
        <input aria-label="Description" className="grow-text" placeholder="What this workflow is for" value={d.description} disabled={!editable} onChange={(e) => setD({ ...d, description: e.target.value })} />
      </div>

      <h5>Stages</h5>
      <table className="table wf-stages">
        <thead><tr><th>Colour</th><th>Name</th><th>Kind</th><th /></tr></thead>
        <tbody>
          {d.stages.map((x, i) => (
            <tr key={x.key}>
              <td><input type="color" aria-label={`Colour of ${x.name}`} value={x.color || '#7a8b99'} disabled={!editable} onChange={(e) => setStage(i, { color: e.target.value })} /></td>
              <td><input aria-label={`Name of stage ${i + 1}`} value={x.name} disabled={!editable} onChange={(e) => setStage(i, { name: e.target.value })} /></td>
              <td><select aria-label={`Kind of ${x.name}`} value={x.category} disabled={!editable} onChange={(e) => setStage(i, { category: e.target.value })}>{STAGE_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</select></td>
              <td className="wf-actions">
                {editable && <button type="button" className="link" aria-label={`Move ${x.name} up`} disabled={i === 0} onClick={() => shift(i, -1)}>↑</button>}
                {editable && <button type="button" className="link" aria-label={`Move ${x.name} down`} disabled={i === d.stages.length - 1} onClick={() => shift(i, 1)}>↓</button>}
                {editable && <button type="button" className="link" aria-label={`Remove ${x.name}`} disabled={d.stages.length === 1} onClick={() => removeStage(i)}>Remove</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editable && <button type="button" onClick={addStage}>Add a stage</button>}
      {removed.filter((x) => (s.usage[w.id]?.byStage[x.key] ?? 0) > 0).length > 0 && (
        <div className="banner" role="status">
          {removed.filter((x) => (s.usage[w.id]?.byStage[x.key] ?? 0) > 0).map((x) => (
            <div key={x.key} className="row">
              <span>{s.usage[w.id]!.byStage[x.key]} project{s.usage[w.id]!.byStage[x.key] === 1 ? '' : 's'} in “{x.name}” go to</span>
              <select aria-label={`Where projects in ${x.name} go`} value={d.moveProjects[x.key] ?? d.stages[0]?.key ?? ''} onChange={(e) => setD({ ...d, moveProjects: { ...d.moveProjects, [x.key]: e.target.value } })}>
                {d.stages.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}

      <h5>Moves and gates</h5>
      <p className="muted small">Tick where each stage can go. A move with a gate lists who may make it and what the project needs first; with no gate, anyone who can move projects can make it.</p>
      {editable && (
        <div className="row">
          <button type="button" onClick={everyMove}>Every stage can go to every other</button>
          <button type="button" onClick={oneStep}>One step forward or back</button>
        </div>
      )}
      <div className="wf-moves">
        {d.stages.map((from) => (
          <fieldset key={from.key}>
            <legend>From <strong>{from.name}</strong></legend>
            {d.stages.filter((to) => to.key !== from.key).map((to) => {
              const m = moveOf(from.key, to.key);
              const id = `${from.key}>${to.key}`;
              return (
                <div key={to.key} className="wf-move">
                  <label className="inline"><input type="checkbox" disabled={!editable} checked={!!m} onChange={(e) => toggleMove(from.key, to.key, e.target.checked)} /> {to.name}</label>
                  {m && <button type="button" className="link small" aria-expanded={gate === id} aria-label={`Gate for ${from.name} to ${to.name}`} onClick={() => setGate(gate === id ? null : id)}>{gateSummary(m) || 'Gate…'}</button>}
                  {m && gate === id && <Gate m={m} s={s} editable={editable} onChange={(patch) => setMove(from.key, to.key, patch)} />}
                </div>
              );
            })}
          </fieldset>
        ))}
      </div>

      {editable && (
        <div className="row">
          <button type="button" className="primary" disabled={!dirty} onClick={save}>Save workflow</button>
          <button type="button" disabled={!dirty} onClick={() => setD(original)}>Discard changes</button>
          {!w.defaultFor.includes('subproject') && (
            <button type="button" disabled={dirty} title={dirty ? 'Save first' : undefined} onClick={() => void act(() => api.setDefault(w.id, ['subproject']), `“${w.name}” is now the default for new books.`)}>Default for new books</button>
          )}
          <button type="button" onClick={() => { const n = window.prompt('Name for the copy', `${w.name} (copy)`); if (n) void act(() => api.create({ name: n, copyFrom: w.id })).then((r) => r && onPick(r.id)); }}>Copy…</button>
          <button type="button" className="link" disabled={w.defaultFor.length > 0 || (s.usage[w.id]?.projects ?? 0) > 0} title={w.defaultFor.length ? 'Make another workflow the default first' : (s.usage[w.id]?.projects ?? 0) ? 'Projects still use this workflow' : undefined} onClick={() => { if (window.confirm(`Delete “${w.name}”?`)) void act(() => api.delete(w.id)).then(() => onPick(null)); }}>Delete</button>
        </div>
      )}
      {w.defaultFor.length > 0 && <p className="muted small">This is the default for new books. Stages belong to books: a project (a series) has none. {w.templateKey === 'mdedit' ? 'It is the one Cadrel ships, with the stages from MDEdit; edit it, or build another and make that the default.' : ''}</p>}
    </div>
  );
}

/** Who may make a move, and what must be true of the project. */
function Gate({ m, s, editable, onChange }: { m: DraftMove; s: Ready; editable: boolean; onChange: (patch: Partial<DraftMove>) => void }) {
  const has = (kind: ConditionKind) => m.conditions.find((c) => c.kind === kind);
  const toggle = (kind: ConditionKind, on: boolean) => onChange({ conditions: on ? [...m.conditions, { kind }] : m.conditions.filter((c) => c.kind !== kind) });
  return (
    <div className="wf-gate" role="group" aria-label="Gate">
      <div><strong className="small">Who may make this move</strong></div>
      <div className="row">
        {s.roles.map((r) => (
          <label key={r.id} className="inline small"><input type="checkbox" disabled={!editable} checked={m.roleIds.includes(r.id)} onChange={(e) => onChange({ roleIds: e.target.checked ? [...m.roleIds, r.id] : m.roleIds.filter((x) => x !== r.id) })} /> {r.name}</label>
        ))}
      </div>
      <p className="muted small">{m.roleIds.length ? 'Only people holding one of these roles (an Owner always may).' : 'No role chosen: anyone who may move projects.'}</p>
      <div><strong className="small">The project needs</strong></div>
      {(Object.keys(CONDITION_KINDS) as ConditionKind[]).filter((k) => k !== 'approved').map((kind) => {
        const c = has(kind);
        return (
          <div key={kind} className="row">
            <label className="inline small"><input type="checkbox" disabled={!editable} checked={!!c} onChange={(e) => toggle(kind, e.target.checked)} /> {CONDITION_KINDS[kind]}</label>
          </div>
        );
      })}
      <SignOffs m={m} editable={editable} onChange={onChange} />
    </div>
  );
}

/** "Signed off" gates: the labels of the sign-offs a project must stand approved under (Cover approved, Legal…). Each is a separate condition. */
function SignOffs({ m, editable, onChange }: { m: DraftMove; editable: boolean; onChange: (patch: Partial<DraftMove>) => void }) {
  const [label, setLabel] = useState('');
  const labels = m.conditions.filter((c) => c.kind === 'approved');
  const add = () => {
    const l = label.trim().replace(/\s+/g, ' ');
    if (l && !labels.some((c) => c.label?.toLowerCase() === l.toLowerCase())) onChange({ conditions: [...m.conditions, { kind: 'approved', label: l }] });
    setLabel('');
  };
  return (
    <div>
      {labels.map((c) => (
        <div key={c.label} className="row">
          <span className="small">{CONDITION_KINDS.approved}: <strong>{c.label}</strong></span>
          {editable && <button type="button" className="link small" aria-label={`Remove the ${c.label} sign-off`} onClick={() => onChange({ conditions: m.conditions.filter((x) => x !== c) })}>Remove</button>}
        </div>
      ))}
      {editable && (
        <div className="row">
          <input aria-label="Sign-off label" placeholder="Sign-off needed, e.g. Cover approved" maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())} />
          <button type="button" disabled={!label.trim()} onClick={add}>Require sign-off</button>
        </div>
      )}
    </div>
  );
}
