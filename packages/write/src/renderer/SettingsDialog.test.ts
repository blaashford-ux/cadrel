// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultAppDefaults } from '../shared/appDefaults';
import { defaultProjectsSettings } from '../shared/projects';
import { SettingsDialog } from './SettingsDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEFAULT = 'C:\\Users\\me\\MDEdit';

async function open(config: { setupDone: boolean; rootExists: boolean }) {
  const setProjectsConfig = vi.fn(async () => ({}));
  (window as unknown as { mdedit: unknown }).mdedit = {
    getAppDefaults: async () => defaultAppDefaults(),
    getPrefs: async () => ({}),
    getProjectsConfig: async () => ({ ...defaultProjectsSettings(), ...config, root: DEFAULT, defaultRoot: DEFAULT }),
    listProjects: async () => ({ root: DEFAULT, exists: config.rootExists, projects: [], folders: [] }),
    capabilities: () => ({}),
    setProjectsConfig,
  };
  const onSave = vi.fn(async () => true);
  const host = document.body.appendChild(document.createElement('div'));
  await act(async () => createRoot(host).render(createElement(SettingsDialog, { onSave, onClose: () => undefined })));
  const save = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save') as HTMLButtonElement;
  return { save, setProjectsConfig, onSave };
}

describe('Settings → Save on a first run', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('can be pressed with the default Root Folder, which it then saves and creates', async () => {
    const { save, setProjectsConfig, onSave } = await open({ setupDone: false, rootExists: false });
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    expect(setProjectsConfig).toHaveBeenCalledWith(expect.objectContaining({ rootFolder: DEFAULT, setupDone: true }));
    expect(onSave).toHaveBeenCalled();
  });

  it('stays disabled when nothing has changed on a set-up install', async () => {
    const { save } = await open({ setupDone: true, rootExists: true });
    expect(save.disabled).toBe(true);
  });
});
