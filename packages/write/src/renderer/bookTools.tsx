import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthorKit } from '../shared/api';
import { insertText } from '../shared/bookKit';
import { BLOCK_KIND_LABEL, blocksFor, type BlockKind, type TextBlock } from '../shared/textBlocks';

/** What the Book Details form can offer from outside the book: saved text blocks, and the author's profile and books (where Cadrel hosts Write). */
interface Tools {
  /** Null where Write has no host for them: the form then simply shows no such choices. */
  kit: AuthorKit | null;
  /** Null until the list is read, or where blocks cannot be saved. */
  blocks: TextBlock[] | null;
  save(input: { kind: BlockKind; name: string; text: string }): Promise<void>;
  remove(id: string): Promise<void>;
}

const ToolsContext = createContext<Tools | null>(null);
export const useBookTools = (): Tools | null => useContext(ToolsContext);

const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Gives the forms inside it the tools; inside another provider it just passes its children through (one set of lookups per dialog). */
export function BookToolsProvider({ children }: { children: ReactNode }) {
  const outer = useContext(ToolsContext);
  const api = window.cadrelWrite;
  const [kit, setKit] = useState<AuthorKit | null>(null);
  const [blocks, setBlocks] = useState<TextBlock[] | null>(null);
  useEffect(() => {
    if (outer) return;
    let live = true;
    void api.authorKit?.().then((k) => live && setKit(k), () => undefined);
    void api.listTextBlocks?.().then((b) => live && setBlocks(b), () => undefined);
    return () => {
      live = false;
    };
  }, [api, outer]);
  const reload = useCallback(async () => setBlocks((await api.listTextBlocks?.()) ?? null), [api]);
  const value = useMemo<Tools>(
    () => ({
      kit,
      blocks: api.saveTextBlock ? blocks : null,
      save: async (input) => {
        await api.saveTextBlock!(input);
        await reload();
      },
      remove: async (id) => {
        await api.deleteTextBlock!(id);
        await reload();
      }
    }),
    [api, kit, blocks, reload]
  );
  return outer ? <>{children}</> : <ToolsContext.Provider value={value}>{children}</ToolsContext.Provider>;
}

/**
 * Beside a text field: put a saved block into it, save what is in it as a block, or delete a block. The blocks offered are the ones for that
 * part of the book (front matter, copyright page, back matter), so a dedication never appears among author bios.
 */
export function BlockTools({ kind, value, onChange }: { kind: BlockKind; value: string; onChange(v: string): void }) {
  const tools = useBookTools();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  if (!tools || tools.blocks === null) return null;
  const mine = blocksFor(tools.blocks, kind);
  const save = async () => {
    try {
      await tools.save({ kind, name, text: value });
      setNaming(false);
      setName('');
      setError('');
    } catch (e) {
      setError(clean(e));
    }
  };
  return (
    <div className="block-tools">
      <details className="block-menu">
        <summary>Saved blocks{mine.length ? ` (${mine.length})` : ''}</summary>
        <div className="block-list" aria-label={`Saved ${BLOCK_KIND_LABEL[kind].toLowerCase()} blocks`}>
          {mine.length === 0 && <p className="muted small">Nothing saved here yet. Write the text, then choose Save as block.</p>}
          {mine.map((b) => (
            <div className="block-row" key={b.id}>
              <span className="block-name" title={b.text}>{b.name}</span>
              <button type="button" onClick={() => onChange(insertText(value, b.text))}>Use</button>
              <button type="button" aria-label={`Delete ${b.name}`} onClick={() => window.confirm(`Delete the saved block “${b.name}”?`) && void tools.remove(b.id)}>✕</button>
            </div>
          ))}
        </div>
      </details>
      {!naming ? (
        <button type="button" className="link" disabled={!value.trim()} onClick={() => setNaming(true)} title={value.trim() ? 'Keep this text to use in other books' : 'Write some text first'}>Save as block…</button>
      ) : (
        <span className="block-name-form">
          <input autoFocus aria-label="Name for this block" placeholder="Name (saving under a name already used replaces it)" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }} />
          <button type="button" className="primary" disabled={!name.trim()} onClick={() => void save()}>Save</button>
          <button type="button" onClick={() => (setNaming(false), setError(''))}>Cancel</button>
        </span>
      )}
      {error && <span className="bad" role="alert">{error}</span>}
    </div>
  );
}
