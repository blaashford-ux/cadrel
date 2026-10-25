import { useEffect, useState } from 'react';
import type { BookText } from '../../shared/api.js';

const api = window.cadrelMarket;
const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)}%`);
const n = (v: number | null | undefined, d = 1) => (v == null ? '–' : Number(v.toFixed(d)).toLocaleString('en-US'));

export function TextCard({ asin }: { asin: string }) {
  const [t, setT] = useState<BookText | null>(null);
  const [over, setOver] = useState(false);
  const [msg, setMsg] = useState('');

  const load = () => void api.bookText(asin).then(setT);
  useEffect(() => {
    load();
    return api.onText(load);
  }, [asin]);

  const run = async (f: () => Promise<unknown>) => {
    setMsg('');
    try { await f(); } catch (e) { setMsg(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    load();
  };

  if (!t) return null;
  const upload = t.manuscripts.find((m) => m.source === 'upload');
  const sample = t.manuscripts.find((m) => m.source === 'sample');
  const unread = t.sampleSessions.filter((s) => s.read < s.pages);
  const m = t.metrics?.metrics;

  return (
    <div className="card" aria-label="Book text">
      <h2 style={{ marginTop: 0 }}>Text of the book</h2>
      <p className="muted">
        Analysis of pacing, dialogue and openings needs the book's words. Drop the book file here, or capture the free sample with the browser extension (Start sample capture, then turn the pages).
      </p>

      <div
        className="drop"
        data-over={over}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files[0];
          if (f) void run(() => api.attachManuscriptPath(asin, api.pathForFile(f)));
        }}
      >
        Drop a PDF, EPUB, Word or text file here
        <button style={{ marginLeft: 12 }} onClick={() => void run(() => api.attachManuscript(asin))}>Choose file…</button>
      </div>

      {t.job && (
        <div role="status" className="muted">
          {t.job.phase === 'reading' ? 'Reading the file…' : `Reading sample pages… ${t.job.done} of ${t.job.total}`}
        </div>
      )}
      {(msg || t.error) && <div className="err" role="alert">{msg || t.error}</div>}

      <table style={{ marginTop: 10 }}>
        <tbody>
          <tr>
            <td style={{ width: 150 }}>Full book</td>
            <td>
              {upload ? <>{upload.label} · {upload.words.toLocaleString()} words · {upload.chapters} chapter{upload.chapters === 1 ? '' : 's'}{upload.pages ? ` · ${upload.pages} pages` : ''}{' '}
                <button className="link" onClick={() => void run(() => api.removeText(asin, 'upload'))}>Remove</button></> : <span className="muted">none</span>}
              {upload?.warnings.map((w, i) => <div key={i} className="err">{w}</div>)}
            </td>
          </tr>
          <tr>
            <td>Free sample</td>
            <td>
              {sample ? <>{sample.words.toLocaleString()} words from {sample.pages ?? '?'} page{sample.pages === 1 ? '' : 's'} · read at {sample.quality ?? '–'}% confidence · {sample.complete ? 'reached the end of the sample' : 'may be partial: the end-of-sample page was not seen'}{' '}
                <button className="link" onClick={() => void run(() => api.removeText(asin, 'sample'))}>Remove</button></> : <span className="muted">none</span>}
              {sample?.warnings.map((w, i) => <div key={i} className="err">{w}</div>)}
              {unread.map((s) => (
                <div key={s.session}>
                  {s.pages} screenshot{s.pages === 1 ? '' : 's'} captured ({s.read} read){' '}
                  <button onClick={() => void run(() => api.readSample(asin, s.session))} disabled={!!t.job}>Read the pages</button>
                </div>
              ))}
              {!sample && !unread.length && <span className="muted"> </span>}
            </td>
          </tr>
        </tbody>
      </table>

      {m && (
        <>
          <h2>What the text shows{t.metrics!.source === 'sample' ? ' (from the sample only)' : ''}</h2>
          {t.metrics!.source === 'sample' && <div className="muted">A sample is roughly the first tenth of the book: opening and style figures are reliable, length and chapter figures are not.</div>}
          <div className="two">
            <table>
              <tbody>
                <tr><td>Words</td><td className="num">{m.words.toLocaleString()}</td></tr>
                <tr><td>Chapters{t.metrics!.source === 'sample' ? ' (in the sample)' : ''}</td><td className="num">{m.chapters.count} (avg {n(m.chapters.avgWords, 0)} words)</td></tr>
                <tr><td>Dialogue share</td><td className="num">{pct(m.dialogueShare)}</td></tr>
                <tr><td>Average sentence</td><td className="num">{n(m.avgSentenceWords)} words</td></tr>
                <tr><td>Sentences of 6 words or fewer</td><td className="num">{pct(m.sentenceLength.shortShare)}</td></tr>
                <tr><td>Reading ease / grade</td><td className="num">{n(m.readingEase)} / {n(m.gradeLevel)}</td></tr>
              </tbody>
            </table>
            <table>
              <tbody>
                <tr><td colSpan={2}><strong>Opening (first ~{m.opening.words} words)</strong></td></tr>
                <tr><td>First sentence</td><td className="num">{m.opening.firstSentenceWords ?? '–'} words</td></tr>
                <tr><td>Dialogue</td><td className="num">{pct(m.opening.dialogueShare)}{m.opening.startsWithDialogue ? ' (opens with speech)' : ''}</td></tr>
                <tr><td>Names introduced per 100 words</td><td className="num">{n(m.opening.properNounsPer100)}</td></tr>
                <tr><td>Questions / exclamations</td><td className="num">{m.opening.questions} / {m.opening.exclamations}</td></tr>
              </tbody>
            </table>
          </div>
          {m.opening.firstSentence && <blockquote className="muted" style={{ margin: '8px 0 0', borderLeft: '3px solid var(--line)', paddingLeft: 10 }}>{m.opening.firstSentence}</blockquote>}
        </>
      )}
    </div>
  );
}
