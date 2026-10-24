// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultProjectsSettings } from '../shared/projects';
import { WelcomeDialog } from './WelcomeDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const config = { ...defaultProjectsSettings(), root: 'C:\\Users\\me\\MDEdit', defaultRoot: 'C:\\Users\\me\\MDEdit', rootExists: false };

describe('the first-run Welcome dialog', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('can be finished with the default Root Folder, without picking one', async () => {
    const setProjectsConfig = vi.fn(async () => config);
    (window as unknown as { mdedit: unknown }).mdedit = { setProjectsConfig };
    const onDone = vi.fn();
    const host = document.body.appendChild(document.createElement('div'));
    const r = createRoot(host);
    await act(async () => r.render(createElement(WelcomeDialog, { config, lastFolder: null, onDone })));
    const go = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Get started') as HTMLButtonElement;
    expect(host.querySelector('.root-path')?.textContent).toBe('C:\\Users\\me\\MDEdit');
    expect(go.disabled).toBe(false);
    await act(async () => go.click());
    expect(setProjectsConfig).toHaveBeenCalledWith({ rootFolder: 'C:\\Users\\me\\MDEdit', setupDone: true });
    expect(onDone).toHaveBeenCalledWith(null);
  });
});
