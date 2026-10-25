import { CHARACTER_TROPES, THEMES, TROPES } from '@cadrel/market-core';
import type { Db } from '../schema.js';
import { categoryBooks } from '../category.js';
import { STOP } from './clusters.js';
import { asStems, lexiconHits, looksLikeSearchTerm } from '../keywords/lexicon.js';

/**
 * What the subreddits linked to a category are talking about and asking for, from the threads and comments already synced.
 * Everything is counted from words (no model reads the text), so it shows what is mentioned and how often, not why; a mention is not
 * approval. The sample is whatever the user synced (a week per sync) from communities of people who chose to post.
 */

// ---------------------------------------------------------------- dictionaries

/** Wants and dealbreakers specific to reader conversations, beside the genre and relationship tropes the rest of the app counts. */
const EXTRA: Record<string, RegExp> = {
  standalone: /\bstand-?alones?\b|\bone[- ]shots?\b|\bcomplete series\b|\bfinished series\b/i,
  cliffhanger: /\bcliff-?hangers?\b/i,
  'happy (HEA/HFN)': /\bhea\b|\bhfn\b|\bhappy ending\b|\bhappily ever after\b/i,
  'cozy mystery': /\bcozy mysteries?\b|\bwhodunit\b|\bamateur sleuth\b/i,
  romantasy: /\bromantasy\b|\bromance[- ]fantasy\b/i,
  'grimdark / dark fantasy': /\bgrimdark\b|\bdark fantasy\b/i,
  'LGBTQ+': /\blgbtq\w*\b|\bqueer\b|\bsapphic\b|\bwlw\b|\bmlm\b|\bgay\b|\blesbian\b|\bbisexual\b|\btrans\b|\bnon-?binary\b|\basexual\b/i,
  'older protagonist': /\bolder (?:protagonist|heroine|mc|woman|main character)\b|\bmid-?life\b|\bmature (?:heroine|protagonist)\b|\bmiddle[- ]aged\b/i,
  'food / cooking': /\bbak(?:ing|er|ery)\b|\bcooking\b|\bfood\b|\brestaurant\b|\bchef\b/i,
  audiobook: /\baudiobooks?\b|\baudible\b|\bnarrator\b/i,
  'Kindle Unlimited': /\bkindle unlimited\b|\bku\b/i,
  'first-person POV': /\bfirst[- ]person\b/i,
  'multiple POV': /\bmultiple (?:pov|povs|perspectives)\b|\bdual pov\b|\bdual timeline\b/i,
  'insta-love': /\binsta-?love\b|\binstalove\b/i,
  miscommunication: /\bmiscommunication\b|\bmisunderstanding\b/i,
  'strong female lead': /\bstrong (?:female|woman|heroine|lead|fmc)\b|\bfmc\b/i,
  'worldbuilding / magic system': /\bworld-?building\b|\bmagic system\b|\bhard magic\b|\bsoft magic\b/i,
};

/** Relationship tropes, then the genre tropes the packaging analysis uses (skipping spellings that repeat one), then the extras. */
export const ELEMENTS: Record<string, RegExp> = (() => {
  const out: Record<string, RegExp> = { ...CHARACTER_TROPES };
  const have = new Set(Object.keys(out).map((k) => k.toLowerCase().replace(/[^a-z]/g, '')));
  for (const [k, re] of Object.entries(TROPES)) {
    const n = k.toLowerCase().replace(/[^a-z]/g, '');
    if (have.has(n) || /^(?:grumpy|closed|enemies|slow|fake|found|chosen)/.test(n)) continue;
    out[k] = re;
  }
  return { ...out, ...EXTRA };
})();

const REQUEST = /\b(?:looking for|recommend(?:ation)?s?|recs?|suggest(?:ion)?s?|any (?:books?|good|more|other)|anyone know|does anyone know|help me find|help finding|need (?:a|some|more)|what (?:should|can|do) i read|something (?:like|with|similar)|books? (?:like|similar|with|where|about)|where (?:do|should) i start|searching for|in the mood for|craving|i want|i'?d love|any ideas)\b/i;
const REQUEST_FLAIR = /recommend|request|looking|suggest|find/i;
const POSITIVE = /\b(?:love[sd]?|loving|favou?rite|adore[sd]?|obsessed|can'?t get enough|amazing|perfect|gem|wonderful|enjoy(?:ed|s)?|delightful|more of|want more|yes please|so good)\b/i;
const NEGATIVE = /\b(?:hate[sd]?|tired of|sick of|can'?t stand|cannot stand|dnf(?:'?d|ed)?|did not finish|didn'?t finish|avoid(?:ing|ed)?|not a fan|turn[- ]?off|deal-?breaker|overdone|overused|annoying|boring|disappoint\w*|too (?:much|many)|ruined|cringe|no thanks)\b/i;
const AVOID_CLAUSE = /(?:tired of|sick of|can'?t stand|cannot stand|hate[sd]?|dnf'?d?|avoid(?:ing)?|not a fan of|too (?:much|many)|overdone|overused|annoying)\b[^.!?\n]{2,110}/i;

/** Words that fill reader chatter without saying what is wanted. */
const CHATTER = new Set(
  ('recommend recommendation recommendations rec recs suggest suggestion suggestions looking anyone anybody something anything everyone thanks thank please really thing things think know want wants need needs good great best love loved loves also much many still even well get got going yes yeah lot lots people time make made way sure find post thread read reading reads write writing wrote author authors actually definitely probably maybe pretty enjoy enjoyed enjoying favorite favourite favourites favorites check try tried trying ending ended another others else quite rather though although however since while around going come comes came look looks looked seems seem feel feels felt hope hoping wish wishing mind said says say saying tell told etc own own').split(' '),
);

// ---------------------------------------------------------------- text helpers

const sentences = (t: string) => t.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const normText = (s: string) => ` ${s.toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
const share = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);

export function stem(raw: string): string {
  let w = raw.replace(/['’]s$/, '').replace(/^[-'’]+|[-'’]+$/g, '');
  if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
  else if (/(?:ch|sh|x|z|ss)es$/.test(w) && w.length > 5) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return w;
}

/** Phrases of one or two content words, from clauses (a phrase never spans punctuation or a stop word). */
export function phrasesOf(text: string, ignore: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const clause of text.toLowerCase().split(/[.!?;:,()[\]"“”\n]+/)) {
    let prev: string | null = null;
    for (const raw of clause.match(/[\p{L}][\p{L}'’-]*/gu) ?? []) {
      const w = stem(raw);
      const skip = w.length < 3 || STOP.has(raw) || STOP.has(w) || CHATTER.has(raw) || CHATTER.has(w);
      if (skip) { prev = null; continue; }
      if (w.length >= 4 && !ignore.has(w)) out.add(w);
      if (prev && !(ignore.has(prev) && ignore.has(w))) out.add(`${prev} ${w}`);
      prev = w;
    }
  }
  return out;
}

// ---------------------------------------------------------------- result

export interface ThreadRef {
  title: string;
  subreddit: string;
  url: string;
  score: number | null;
  comments: number;
}

export interface Topic {
  phrase: string;
  /** Threads (post or any comment) that mention it. */
  threads: number;
  share: number | null;
  /** Of those, request threads (someone asking for books). */
  asked: number;
  avgScore: number | null;
  examples: ThreadRef[];
}

export interface ElementRow {
  element: string;
  /** Threads that mention it anywhere, and the share of all threads. */
  threads: number;
  threadShare: number | null;
  /** Request threads whose own title or text mentions it. */
  asked: number;
  /** Posts or comments that mention it in a sentence of praise, and in a sentence of complaint. */
  loved: number;
  avoided: number;
  net: number;
  /** Books on the category's newest lists (by title and blurb) that mention it. */
  supplyBooks: number;
  supplyShare: number | null;
  /**
   * underserved: talked about, few books carry it; crowded: many books, little talk; balanced: otherwise;
   * thin: too little data either way.
   */
  signal: 'underserved' | 'crowded' | 'balanced' | 'thin';
}

export interface Quote {
  text: string;
  subreddit: string;
  url: string;
  score: number | null;
}

export interface RecommendedBook {
  asin: string;
  title: string;
  listRank: number;
  /** Posts and comments that name the book, the threads they are in, and how many were replies in request threads. */
  mentions: number;
  threads: number;
  inRequests: number;
}

export interface CommunityInsights {
  category: string;
  coverage: { subreddits: string[]; threads: number; comments: number; from: string | null; to: string | null; requestThreads: number; requestShare: number | null };
  /** The conversation's recurring phrases. */
  topics: Topic[];
  /** Review-style themes (humour, pacing, characters...) by the share of threads that touch them. */
  themes: { theme: string; threads: number; share: number | null }[];
  /** Request threads, best-engaged first: the plainest statement of what readers are looking for. */
  requests: ThreadRef[];
  /** Tropes and wants: how much they are talked about, asked for, loved, avoided, and carried by the books on the lists. */
  elements: ElementRow[];
  /** Clauses in which readers say what they avoid or are tired of. */
  avoid: Quote[];
  recommended: RecommendedBook[];
  caveats: string[];
}

// ---------------------------------------------------------------- analysis

interface Item {
  kind: 'post' | 'comment';
  id: string;
  threadId: string;
  subreddit: string;
  title: string;
  text: string;
  score: number | null;
  created: number;
}

export function communityInsights(db: Db, categoryKey: string, o: { maxTopics?: number } = {}): CommunityInsights {
  const cat = db.prepare('SELECT name FROM category WHERE key = ?').get(categoryKey) as { name: string | null } | undefined;
  const subs = (db.prepare('SELECT subreddit FROM community_source WHERE category_key = ? ORDER BY subreddit').all(categoryKey) as { subreddit: string }[]).map((r) => r.subreddit);
  const rows = subs.length
    ? (db.prepare(`SELECT kind, id, link_id AS threadId, subreddit, COALESCE(title, '') AS title, body AS text, score, created_utc AS created FROM community_item WHERE subreddit IN (${subs.map(() => '?').join(',')})`).all(...subs) as unknown as Item[])
    : [];
  const posts = rows.filter((r) => r.kind === 'post');
  const comments = rows.filter((r) => r.kind === 'comment');
  const byThread = new Map<string, Item[]>();
  for (const c of comments) byThread.set(c.threadId, [...(byThread.get(c.threadId) ?? []), c]);

  const threadUrl = (p: Item) => `https://www.reddit.com/r/${p.subreddit}/comments/${p.id}/`;
  const ref = (p: Item): ThreadRef => ({ title: p.title, subreddit: p.subreddit, url: threadUrl(p), score: p.score, comments: byThread.get(p.id)?.length ?? 0 });
  const flair = new Map((db.prepare("SELECT id, flair FROM community_item WHERE kind = 'post'").all() as { id: string; flair: string | null }[]).map((r) => [r.id, r.flair ?? '']));

  // request threads: someone asking for books
  const isRequest = (p: Item) => REQUEST_FLAIR.test(flair.get(p.id) ?? '') || REQUEST.test(`${p.title}\n${p.text.slice(0, 400)}`) || /\b(?:please|pls|plz)\b/i.test(p.title);
  const requests = posts.filter(isRequest);
  const requestIds = new Set(requests.map((p) => p.id));

  // each thread as one document: its post and every comment
  const docs = posts.map((p) => ({ post: p, text: [p.title, p.text, ...(byThread.get(p.id) ?? []).map((c) => c.text)].join('\n') }));

  const times = rows.map((r) => r.created).sort((a, b) => a - b);
  const coverage = {
    subreddits: subs, threads: posts.length, comments: comments.length,
    from: times.length ? new Date(times[0]! * 1000).toISOString() : null, to: times.length ? new Date(times[times.length - 1]! * 1000).toISOString() : null,
    requestThreads: requests.length, requestShare: share(requests.length, posts.length),
  };

  // topics: recurring one- and two-word phrases, by how many threads they appear in
  const ignore = new Set<string>();
  for (const w of `${cat?.name ?? ''} ${subs.join(' ')}`.toLowerCase().match(/[\p{L}]+/gu) ?? []) ignore.add(stem(w));
  for (const s of subs) for (const w of s.toLowerCase().replace(/([a-z])(?=(?:fantasy|romance|books|reads|readers|lit|sf|scifi)\b)/g, '$1 ').split(' ')) ignore.add(stem(w));
  // A topic is a search term: a term from the genre's vocabulary, or a pair of meaningful words that recur together. A single recurring
  // word is not a topic unless the vocabulary has it, and filler ("next", "don't", "back", "without") never is.
  const members = new Map<string, Set<number>>();
  docs.forEach((d, i) => {
    for (const ph of phrasesOf(d.text, ignore)) {
      if (!looksLikeSearchTerm(ph)) continue;
      let set = members.get(ph);
      if (!set) members.set(ph, (set = new Set()));
      set.add(i);
    }
  });
  const known = new Set(members.keys());
  for (const [term, hit] of lexiconHits(docs.map((d) => d.text))) {
    const key = asStems(term).trim();
    if (known.has(key) || key.split(' ').every((w) => ignore.has(w))) continue;
    members.set(term, hit);
  }
  const df = new Map<string, number>([...members].map(([ph, set]) => [ph, set.size]));
  const minDf = Math.max(3, Math.ceil(posts.length * 0.02));
  const ranked = [...df].filter(([ph, n]) => n >= minDf && !ph.split(' ').every((w) => ignore.has(w))).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  const kept: [string, number][] = [];
  for (const [ph, n] of ranked) {
    // a word that almost always appears inside one longer phrase adds nothing beside it
    if (!ph.includes(' ') && kept.some(([k, kn]) => k.includes(' ') && k.split(' ').includes(ph) && kn >= 0.6 * n)) continue;
    kept.push([ph, n]);
    if (kept.length >= (o.maxTopics ?? 30)) break;
  }
  const topics: Topic[] = kept.map(([phrase, n]) => {
    const hit = docs.filter((_, i) => members.get(phrase)!.has(i));
    const scores = hit.map((d) => d.post.score).filter((s): s is number => s !== null);
    return {
      phrase, threads: n, share: share(n, posts.length), asked: hit.filter((d) => requestIds.has(d.post.id)).length,
      avgScore: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
      examples: [...hit].sort((a, b) => (b.post.score ?? 0) - (a.post.score ?? 0)).slice(0, 2).map((d) => ref(d.post)),
    };
  });

  const themes = Object.entries(THEMES)
    .map(([theme, re]) => ({ theme, threads: docs.filter((d) => re.test(d.text)).length }))
    .map((t) => ({ ...t, share: share(t.threads, posts.length) }))
    .filter((t) => t.threads > 0)
    .sort((a, b) => b.threads - a.threads);

  const requestRefs = [...requests].sort((a, b) => (b.score ?? 0) + 2 * (byThread.get(b.id)?.length ?? 0) - ((a.score ?? 0) + 2 * (byThread.get(a.id)?.length ?? 0))).slice(0, 15).map(ref);

  // elements: talked about, asked for, loved, avoided, and supplied by the books on the lists
  const books = categoryBooks(db, categoryKey);
  const blurbOf = db.prepare(`SELECT t.body FROM text_block t JOIN snapshot s ON s.id = t.snapshot_id WHERE s.asin = ? AND t.kind = 'blurb' ORDER BY s.captured_at DESC LIMIT 1`);
  const bookText = books.map((b) => `${b.title ?? ''}\n${(blurbOf.get(b.asin) as { body: string } | undefined)?.body ?? ''}`);
  const loved = new Map<string, Set<string>>();
  const avoided = new Map<string, Set<string>>();
  for (const it of rows) {
    for (const s of sentences(`${it.title}. ${it.text}`)) {
      const pos = POSITIVE.test(s);
      const neg = NEGATIVE.test(s);
      if (pos === neg) continue;
      for (const [k, re] of Object.entries(ELEMENTS)) {
        if (!re.test(s)) continue;
        const m = pos ? loved : avoided;
        m.set(k, (m.get(k) ?? new Set()).add(`${it.kind}:${it.id}`));
      }
    }
  }
  const elements: ElementRow[] = [];
  for (const [element, re] of Object.entries(ELEMENTS)) {
    const threads = docs.filter((d) => re.test(d.text)).length;
    const asked = requests.filter((p) => re.test(`${p.title}\n${p.text}`)).length;
    const supplyBooks = bookText.filter((t) => re.test(t)).length;
    if (!threads && !supplyBooks) continue;
    const threadShare = share(threads, posts.length);
    const supplyShare = share(supplyBooks, books.length);
    const l = loved.get(element)?.size ?? 0;
    const a = avoided.get(element)?.size ?? 0;
    const signal: ElementRow['signal'] =
      threads < 3 || books.length < 10 ? 'thin'
      : threadShare! >= 0.05 && (supplyShare ?? 0) <= threadShare! / 2 ? 'underserved'
      : (supplyShare ?? 0) >= 0.2 && (supplyShare ?? 0) >= 2 * threadShare! ? 'crowded'
      : 'balanced';
    elements.push({ element, threads, threadShare, asked, loved: l, avoided: a, net: l - a, supplyBooks, supplyShare, signal });
  }
  elements.sort((x, y) => y.threads - x.threads || y.supplyBooks - x.supplyBooks || x.element.localeCompare(y.element));

  // what readers say they avoid
  const seen = new Set<string>();
  const avoid: Quote[] = [];
  for (const it of [...rows].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    for (const s of sentences(`${it.title}. ${it.text}`)) {
      const m = AVOID_CLAUSE.exec(s);
      if (!m) continue;
      const text = clip(m[0].replace(/\s+/g, ' ').trim(), 140);
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const post = it.kind === 'post' ? it : posts.find((p) => p.id === it.threadId);
      avoid.push({ text, subreddit: it.subreddit, url: post ? threadUrl(post) : `https://www.reddit.com/r/${it.subreddit}/comments/${it.threadId}/`, score: it.score });
      if (avoid.length >= 12) break;
    }
    if (avoid.length >= 12) break;
  }

  // books named in the conversation, from the titles on the category's lists
  const titles = books.map((b) => {
    const short = (b.title ?? '').replace(/[([].*?[)\]]/g, ' ').split(/\s[–—-]\s|:/)[0] ?? '';
    const n = normText(short).trim();
    return { b, n: n.split(' ').length >= 2 && n.length >= 8 ? ` ${n} ` : null };
  }).filter((x): x is { b: (typeof books)[number]; n: string } => x.n !== null);
  const counts = new Map<string, { items: number; threads: Set<string>; inRequests: number }>();
  for (const it of rows) {
    const text = normText(`${it.title} ${it.text}`);
    for (const t of titles) {
      if (!text.includes(t.n)) continue;
      const c = counts.get(t.b.asin) ?? { items: 0, threads: new Set<string>(), inRequests: 0 };
      c.items++;
      c.threads.add(it.threadId);
      if (it.kind === 'comment' && requestIds.has(it.threadId)) c.inRequests++;
      counts.set(t.b.asin, c);
    }
  }
  const recommended: RecommendedBook[] = [...counts]
    .map(([asin, c]) => { const b = books.find((x) => x.asin === asin)!; return { asin, title: b.title ?? asin, listRank: b.listRank, mentions: c.items, threads: c.threads.size, inRequests: c.inRequests }; })
    .sort((a, b) => b.inRequests - a.inRequests || b.mentions - a.mentions || a.listRank - b.listRank)
    .slice(0, 15);

  const caveats = [
    posts.length === 0
      ? 'No community text is synced for this category yet: link a subreddit under Community sources and press Sync.'
      : `${posts.length.toLocaleString()} threads and ${comments.length.toLocaleString()} comments from ${subs.map((s) => `r/${s}`).join(', ')}, ${coverage.from?.slice(0, 10)} to ${coverage.to?.slice(0, 10)}. Each sync reads one week, so this is a snapshot of what those readers were discussing then.`,
    'Counts come from words and phrases, not from understanding the text: a trope is counted wherever its words appear, including in "I don\'t like X", and the praise/complaint split only looks at one sentence at a time.',
    'The people who post in a subreddit are not all readers: they are the ones who chose to write, in communities with their own tastes.',
    ...(requests.length < 10 && posts.length > 0 ? [`Only ${requests.length} request thread${requests.length === 1 ? '' : 's'} were found, so "asked for" is a small sample.`] : []),
    ...(books.length < 10 ? ['Fewer than 10 books are captured on this category\'s lists, so the supply side of the comparison is too thin to read.'] : []),
  ];

  return { category: cat?.name ?? categoryKey, coverage, topics, themes, requests: requestRefs, elements, avoid, recommended, caveats };
}
