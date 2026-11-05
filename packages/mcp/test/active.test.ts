import { describe, expect, it } from 'vitest';
import { expandActive } from '../src/active.js';

const file = (o: unknown) => () => JSON.stringify(o);

describe('--active', () => {
  it('leaves the arguments alone when there is no --active', () => {
    expect(expandActive(['--root', '/a', '--http'])).toEqual(['--root', '/a', '--http']);
  });

  it('takes the Studio\'s arguments from the file, and the file wins over what an old configuration baked in', () => {
    const out = expandActive(['x.mjs', '--root', 'C:/Loric/Projects', '--library', 'C:/Loric/Market', '--active', 'a.json', '--http'], file({ studio: 'Black Cat Books', args: ['--root', 'C:/BlackCat/Projects', '--library', 'C:/BlackCat/Market'] }));
    expect(out).toEqual(['--root', 'C:/BlackCat/Projects', '--library', 'C:/BlackCat/Market', 'x.mjs', '--http']);
  });

  it('drops a baked flag written as --name=value too, and keeps flags the file does not set', () => {
    const out = expandActive(['--root=C:/Loric', '--agent', 'claude', '--active=a.json'], file({ args: ['--root', 'C:/BlackCat'] }));
    expect(out).toEqual(['--root', 'C:/BlackCat', '--agent', 'claude']);
  });

  it('serves no Studio rather than the wrong one when the file cannot be read, and says why', () => {
    const said: string[] = [];
    const out = expandActive(['--root', '/old', '--active', 'missing.json'], () => { throw new Error('ENOENT'); }, (m) => said.push(m));
    expect(out).toEqual(['--root', '/old']);
    expect(said.join()).toMatch(/missing\.json could not be used \(ENOENT\)/);
  });

  it('refuses a file that is not a list of arguments', () => {
    const said: string[] = [];
    expandActive(['--active', 'a.json'], file({ args: 'nope' }), (m) => said.push(m));
    expect(said.join()).toMatch(/no list of arguments/);
  });
});
