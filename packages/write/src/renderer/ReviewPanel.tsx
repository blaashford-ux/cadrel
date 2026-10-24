import { useEffect, useRef, useState } from 'react';
import { CATEGORY_MAX, STANDARD_TOPICS, type Anchor } from '../shared/review/comments';
import type { Identity, ReviewState, ShownItem } from './useReview';

interface Props {
  state: ReviewState;
  me: Identity;
  /** The owner can resolve, accept and delete anyone's notes; a reviewer only their own. */
  role: 'owner' | 'reviewer';
  onRename(name: string): void;
  onClose(): void;
  /** Owner only: opens the sharing dialog. */
  onShare?(): void;
  /** Desktop owner only: opens the dialog for connecting AI reviewers. */
  onAi?(): void;
  /** Ids of the notes that are in the open chapter's text; null when the file has only one chapter (then there is nothing to restrict). */
  inChapter?: Set<string> | null;
  /** Brings a note to the top of the list and marks it (the text of that note was clicked). A new `n` is a new request. */
  focus?: { id: string; n: number } | null;
  /** Shows a note in the text, opening its chapter first. Resolves to a message when it can't be shown. */
  onGoTo?(id: string): Promise<string | null>;
  /** A problem or change worth telling the user about (for example, access withdrawn). */
  notice?: string | null;
  /** Opens the composer on this selection (from the right-click menu). A new `id` is a new request. */
  request?: { id: number; kind: 'comment' | 'suggestion'; sel: { anchor: Anchor; oneBlock: boolean } } | null;
}

const excerpt = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Comments and suggestions on the open chapter's file. */
const CHAPTER_ONLY_KEY = 'mdedit.notes.chapterOnly';
const readChapterOnly = (): boolean => {
  try {
    return localStorage.getItem(CHAPTER_ONLY_KEY) === '1';
  } catch {
    return false;
  }
};

export function ReviewPanel({ state, me, role, onRename, onClose, onShare, onAi, onGoTo, focus, inChapter, notice, request }: Props) {
  const [draft, setDraft] = useState<{ anchor: Anchor; oneBlock: boolean } | null>(null);
  const [kind, setKind] = useState<'comment' | 'suggestion'>('comment');
  const [body, setBody] = useState('');
  const [replacement, setReplacement] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [who, setWho] = useState('all');
  const [category, setCategory] = useState('all');
  /** The topic for the note being written; kept between notes, since a pass tends to stay on one subject. */
  const [topic, setTopic] = useState('');
  /** The note whose topic is being edited, and what is typed. */
  const [topicFor, setTopicFor] = useState<{ id: string; text: string } | null>(null);
  const [chapterOnly, setChapterOnly] = useState(readChapterOnly);
  const [confirmAll, setConfirmAll] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [scrollTick, setScrollTick] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // The text of a note was clicked: show it whatever the filters say, mark it, and (below) scroll it to the top of the list.
  useEffect(() => {
    if (!focus) return;
    const item = state.items.find((i) => i.id === focus.id);
    if (!item) return;
    setWho('all');
    setCategory('all');
    if (item.status !== 'open') setShowDone(true);
    setFocusedId(item.id);
    setScrollTick((t) => t + 1);
  }, [focus?.n]);
  useEffect(() => {
    if (!focusedId || !scrollTick) return;
    const list = listRef.current;
    const row = list && [...list.querySelectorAll<HTMLElement>('[data-note-id]')].find((el) => el.dataset.noteId === focusedId);
    if (!list || !row) return;
    list.style.setProperty('--spacer', `${list.clientHeight}px`); // room below the last note, so any note can reach the top
    const top = list.scrollTop + (row.getBoundingClientRect().top - list.getBoundingClientRect().top);
    list.scrollTo({ top, behavior: 'smooth' });
  }, [scrollTick]);

  useEffect(() => {
    if (!request) return;
    setMessage(null);
    setDraft(request.sel);
    setReplacement(request.sel.anchor.quote);
    setKind(request.kind === 'suggestion' && request.sel.oneBlock ? 'suggestion' : 'comment');
    setBody('');
  }, [request?.id]);

  const begin = () => {
    const sel = state.selection();
    if (!sel) {
      setMessage('Select some text in the chapter first.');
      return;
    }
    setMessage(null);
    setDraft(sel);
    setReplacement(sel.anchor.quote);
    setKind(sel.oneBlock ? kind : 'comment');
  };

  const submit = () => {
    if (!draft) return;
    if (kind === 'comment' && !body.trim()) return;
    if (kind === 'suggestion' && replacement === draft.anchor.quote && !body.trim()) return;
    state.add(draft, kind, body.trim(), kind === 'suggestion' ? replacement : undefined, topic);
    setDraft(null);
    setBody('');
  };

  // Filters only appear once there is something to choose between, and fall back to "all" if their choice goes away.
  const reviewers = [...new Map(state.items.map((i) => [i.reviewerId, i.reviewerName])).entries()];
  const categories = [...new Set(state.items.map((i) => i.category).filter((c): c is string => !!c))].sort();
  const whoNow = reviewers.some(([id]) => id === who) ? who : 'all';
  /** Topics to suggest: those already in the project first, then the standard ones. */
  const topicChoices = [...categories, ...STANDARD_TOPICS.filter((t) => !categories.includes(t))];
  const categoryNow = categories.includes(category) ? category : 'all';
  const thisChapterOnly = chapterOnly && !!inChapter;
  const matching = state.items.filter(
    (i) => (whoNow === 'all' || i.reviewerId === whoNow) && (categoryNow === 'all' || i.category === categoryNow) && (!thisChapterOnly || inChapter!.has(i.id))
  );
  const visible = matching.filter((i) => showDone || i.status === 'open');
  const doneCount = matching.length - matching.filter((i) => i.status === 'open').length;
  const applicable = role === 'owner' && whoNow !== 'all' ? matching.filter((i) => i.kind === 'suggestion' && i.status === 'open') : [];

  // Latest state, for the retries below (the chapter and its editor change while we wait).
  const latest = useRef(state);
  latest.current = state;
  /** Accepts a suggestion, first opening its chapter when it is not the one being edited. Null on success, else why not. */
  const acceptNote = async (id: string): Promise<string | null> => {
    const first = await latest.current.accept(id);
    if (first === null || !onGoTo) return first;
    const moved = await onGoTo(id);
    if (moved) return moved;
    let last: string | null = first;
    for (let tries = 0; tries < 25; tries += 1) {
      await new Promise((r) => setTimeout(r, 100)); // wait for the chapter's editor to come up and draw its notes
      last = await latest.current.accept(id);
      if (last === null) return null;
    }
    return last;
  };

  const applyAll = async () => {
    setConfirmAll(false);
    let done = 0;
    for (const i of applicable) if ((await acceptNote(i.id)) === null) done += 1;
    const left = applicable.length - done;
    setMessage(`Applied ${done} change${done === 1 ? '' : 's'}.${left ? ` ${left} could not be applied here (the text has changed).` : ''}`);
  };
  const mine = (i: ShownItem) => role === 'owner' || i.reviewerId === me.id;

  return (
    <aside className="review-panel" aria-label="Comments and suggestions">
      <datalist id="review-topics">
        {topicChoices.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <div className="review-head">
        <h3>Notes</h3>
        {onAi && <button type="button" className="review-share" onClick={onAi} title="Let Claude, GPT or another AI app review your chapters">AI…</button>}
        {onShare && <button type="button" className="review-share" onClick={onShare}>Share…</button>}
        <button type="button" aria-label="Close notes" onClick={onClose}>×</button>
      </div>

      {notice && <div className="banner warn" role="alert">{notice}</div>}

      {draft ? (
        <div className="review-compose">
          <blockquote>{excerpt(draft.anchor.quote, 160)}</blockquote>
          <div className="review-kinds" role="radiogroup" aria-label="Kind of note">
            <label><input type="radio" checked={kind === 'comment'} onChange={() => setKind('comment')} /> Comment</label>
            <label title={draft.oneBlock ? '' : 'A suggestion has to stay inside one paragraph'}>
              <input type="radio" disabled={!draft.oneBlock} checked={kind === 'suggestion'} onChange={() => setKind('suggestion')} /> Suggest a change
            </label>
          </div>
          {kind === 'suggestion' && (
            <label>
              Change it to
              <textarea value={replacement} onChange={(e) => setReplacement(e.target.value)} rows={3} />
            </label>
          )}
          <label>
            {kind === 'suggestion' ? 'Why (optional)' : 'Your comment'}
            <textarea autoFocus value={body} onChange={(e) => setBody(e.target.value)} rows={3} />
          </label>
          <label>
            Topic (optional)
            <input
              list="review-topics"
              value={topic}
              maxLength={CATEGORY_MAX}
              placeholder="e.g. pacing, continuity"
              onChange={(e) => setTopic(e.target.value)}
            />
          </label>
          <div className="modal-actions">
            <button type="button" onClick={() => setDraft(null)}>Cancel</button>
            <button type="button" className="primary" onClick={submit}>Add</button>
          </div>
        </div>
      ) : (
        <div className="review-begin">
          <button type="button" className="primary" onClick={begin}>Add note on selection</button>
          {message && <p className="review-msg" role="status">{message}</p>}
        </div>
      )}

      {inChapter && (
        <label className="switch review-chapter-switch" title="Show only the notes that are in the chapter you are reading">
          <input
            type="checkbox"
            role="switch"
            checked={chapterOnly}
            onChange={(e) => {
              setChapterOnly(e.target.checked);
              setConfirmAll(false);
              try {
                localStorage.setItem(CHAPTER_ONLY_KEY, e.target.checked ? '1' : '0');
              } catch {
                /* the choice just isn't remembered */
              }
            }}
          />
          <span className="switch-track" aria-hidden="true" />
          <span>This chapter only</span>
        </label>
      )}
      {(reviewers.length > 1 || categories.length > 0) && (
        <div className="review-filters">
          {reviewers.length > 1 && (
            <select aria-label="Show notes from" value={whoNow} onChange={(e) => { setWho(e.target.value); setConfirmAll(false); }}>
              <option value="all">Everyone</option>
              {reviewers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          )}
          {categories.length > 0 && (
            <select aria-label="Show notes about" value={categoryNow} onChange={(e) => setCategory(e.target.value)}>
              <option value="all">All topics</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
        </div>
      )}
      {applicable.length > 1 && (
        <div className="review-bulk">
          {confirmAll ? (
            <>
              <span>Change the text in {applicable.length} places?</span>
              <button type="button" className="primary" onClick={() => void applyAll()}>Apply</button>
              <button type="button" onClick={() => setConfirmAll(false)}>Cancel</button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmAll(true)}>Accept all {applicable.length} suggestions</button>
          )}
        </div>
      )}

      <ul className={`review-list${focusedId ? ' has-focus' : ''}`} ref={listRef}>
        {visible.length === 0 && <li className="review-empty">{thisChapterOnly ? 'No open notes in this chapter.' : state.items.length ? 'No open notes.' : 'No notes on this file yet.'}</li>}
        {visible.map((i) => (
          <li key={i.id} data-note-id={i.id} className={`review-item s-${i.status}${state.detached.has(i.id) ? ' detached' : ''}${i.id === focusedId ? ' focused' : ''}`}>
            <button type="button" className="review-quote" onClick={() => (onGoTo ? void onGoTo(i.id).then(setMessage) : state.focus(i.id))} title="Show in the text">
              {excerpt(i.anchor.quote)}
            </button>
            <div className="review-meta">
              {i.origin === 'ai' && <span className="review-ai" title="Written by an AI reviewer">AI</span>}
              <strong>{i.author}</strong> · {i.kind === 'suggestion' ? 'suggestion' : 'comment'}
              {topicFor?.id === i.id ? null : i.category ? (
                mine(i) ? (
                  <button type="button" className="review-cat editable" title="Change the topic" onClick={() => setTopicFor({ id: i.id, text: i.category ?? '' })}>
                    {i.category}
                  </button>
                ) : (
                  <span className="review-cat">{i.category}</span>
                )
              ) : (
                mine(i) && (
                  <button type="button" className="review-cat editable add" title="Give this note a topic" onClick={() => setTopicFor({ id: i.id, text: '' })}>
                    + topic
                  </button>
                )
              )}
              {i.status !== 'open' && <span className="review-status"> · {i.status}</span>}
              {i.anchor.gone && <span className="review-lost"> · text deleted</span>}
              {state.detached.has(i.id) && <span className="review-lost"> · not in this chapter</span>}
            </div>
            {topicFor?.id === i.id && (
              <form
                className="review-topic-edit"
                onSubmit={(e) => {
                  e.preventDefault();
                  void state.setCategory(i.id, topicFor.text);
                  setTopicFor(null);
                }}
              >
                <input
                  autoFocus
                  list="review-topics"
                  aria-label="Topic"
                  value={topicFor.text}
                  maxLength={CATEGORY_MAX}
                  placeholder="Topic"
                  onChange={(e) => setTopicFor({ id: i.id, text: e.target.value })}
                  onKeyDown={(e) => e.key === 'Escape' && setTopicFor(null)}
                />
                <button type="submit">Save</button>
                {i.category && (
                  <button
                    type="button"
                    onClick={() => {
                      void state.setCategory(i.id, '');
                      setTopicFor(null);
                    }}
                  >
                    Clear
                  </button>
                )}
                <button type="button" onClick={() => setTopicFor(null)}>Cancel</button>
              </form>
            )}
            {i.kind === 'suggestion' && (
              <div className="review-diff">
                <del>{excerpt(i.anchor.quote, 120)}</del> <ins>{excerpt(i.replacement ?? '', 120)}</ins>
              </div>
            )}
            {i.body && <p className="review-body">{i.body}</p>}
            {i.replies.map((r) => (
              <p key={r.id} className="review-reply"><strong>{r.author}:</strong> {r.body}</p>
            ))}
            <div className="review-actions">
              {i.kind === 'suggestion' && i.status === 'open' && role === 'owner' && (
                <button type="button" onClick={() => void acceptNote(i.id).then(setMessage)}>Accept</button>
              )}
              {i.status === 'open' && mine(i) && (
                <button type="button" onClick={() => void state.setStatus(i.id, i.kind === 'suggestion' ? 'rejected' : 'resolved')}>
                  {i.kind === 'suggestion' ? 'Reject' : 'Resolve'}
                </button>
              )}
              {i.status !== 'open' && mine(i) && <button type="button" onClick={() => void state.setStatus(i.id, 'open')}>Reopen</button>}
              <button type="button" onClick={() => setReplyFor(replyFor === i.id ? null : i.id)}>Reply</button>
              {mine(i) && <button type="button" onClick={() => void state.remove(i.id)}>Delete</button>}
            </div>
            {replyFor === i.id && (
              <div className="review-replybox">
                <textarea autoFocus rows={2} value={replyText} onChange={(e) => setReplyText(e.target.value)} />
                <button
                  type="button"
                  disabled={!replyText.trim()}
                  onClick={() => {
                    void state.reply(i.id, replyText.trim());
                    setReplyText('');
                    setReplyFor(null);
                  }}
                >
                  Send
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="review-foot">
        {doneCount > 0 && (
          <label>
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show {doneCount} finished
          </label>
        )}
        <label className="review-name">
          Writing as
          <input value={me.name} onChange={(e) => onRename(e.target.value)} maxLength={40} />
        </label>
      </div>
    </aside>
  );
}
