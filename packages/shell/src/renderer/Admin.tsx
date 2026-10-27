import { useEffect, useState } from 'react';
import { TemplateEditor, type ProjectsDraft } from '@cadrel/write/src/renderer/TemplateEditor';
import { fontService } from '@cadrel/write/src/renderer/fontService';
import { defaultAppDefaults } from '@cadrel/write/src/shared/appDefaults';
import { defaultProjectsSettings, templateErrors, type ProjectsConfig } from '@cadrel/write/src/shared/projects';
import type { AdminView } from '../shared/api';
import { StudioManager } from './StudioManager';
import { PeopleRoles } from './PeopleRoles';

const api = window.cadrel;
// The template editor is Write's own form; here it gets its fonts from the shell.
fontService.installed = () => api.admin.fonts();
fontService.preview = (family) => api.admin.fontPreview(family);

const APP = defaultAppDefaults();

/** What administrators govern for the whole studio. Today: the project templates every new project is made from. */
export function Admin() {
  const [view, setView] = useState<AdminView | null>(null);
  const [draft, setDraft] = useState<ProjectsDraft | null>(null);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = (v: AdminView) => {
    const d: ProjectsDraft = { rootFolder: null, templates: v.templates, defaultTemplateId: v.defaultTemplateId, reopenLast: false, moveProjects: false };
    setView(v);
    setDraft(d);
    setSaved(JSON.stringify(d));
  };
  useEffect(() => void api.admin.get().then(load), []);

  if (!view || !draft) return <p className="muted">Loading…</p>;
  if (!view.isAdmin) return <div className="settings"><section className="card"><h3>Administration</h3><p className="muted">Only the studio’s owner and administrators can change these settings.</p></section></div>;

  const config: ProjectsConfig = { ...defaultProjectsSettings(), templates: draft.templates, defaultTemplateId: draft.defaultTemplateId, root: '', defaultRoot: '', rootExists: true };
  const problems = draft.templates.flatMap((t) => templateErrors(t).map((e) => `${t.name || '(unnamed)'}: ${e}`));
  const dirty = JSON.stringify(draft) !== saved;

  const save = async () => {
    setError(null);
    setNote(null);
    try {
      load(await api.admin.save({ templates: draft.templates, defaultTemplateId: draft.defaultTemplateId }));
      setNote('Saved. New projects use these templates; projects that already exist are not changed.');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="settings admin">
      <StudioManager />
      <PeopleRoles />
      <section className="card" aria-labelledby="a-templates">
        <h3 id="a-templates">Governed by administrators</h3>
        <p className="muted small">
          A template says which folders, starter files and writing defaults a new project gets. They belong to the whole studio: everyone creates projects from these, on the Projects page, and Write does not have its own.
          Changing one never changes projects that already exist. You are {view.role === 'owner' ? 'the studio’s owner' : 'an administrator'}.
        </p>
        <TemplateEditor config={config} draft={draft} setDraft={setDraft} app={APP} projectCount={0} />
        {problems.length > 0 && <div className="banner error" role="alert">{problems[0]}</div>}
        {error && <div className="banner error" role="alert">{error}</div>}
        {note && <div className="banner info" role="status">{note}</div>}
        <div className="row">
          <button type="button" className="primary" disabled={!dirty || problems.length > 0} onClick={() => void save()}>Save templates</button>
          <button type="button" disabled={!dirty} onClick={() => load(view)}>Discard changes</button>
        </div>
      </section>
    </div>
  );
}
