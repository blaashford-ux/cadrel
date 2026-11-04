// Not type-checked with the shell: it imports the Worker (which needs Cloudflare's types, not the DOM ones). vitest checks it by running it.
//
// M3's exit test (docs/PLAN.md): "one real book goes through a full edit inside Cadrel", as an automated run against the real Worker code with
// three people on three computers: an Author, an Editor and a Series Lead, each with their own role. The manual walk-through that covers what this
// cannot (the screens, on Windows) is docs/M3-EXIT-TEST.md.
//
// The book goes through a developmental edit, a line edit and a copy edit. In each round the Editor raises queries, comments and suggestions on the
// exact version of the manuscript; the Author answers every query and accepts, rejects or defers each suggestion (the Author's first round is made
// while their computer is offline); the Author revises the manuscript in the vault, deliberately missing one change they accepted; the Editor
// compares the two versions and checks the revision, which flags the missed change; and the Series Lead closes the pass. A workflow gate on
// Editing → Published holds the move until all three passes are closed, and a proofread, which only advises, never holds it.
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compareTexts, generateKeyPair, makeAnchor, type ProjectFacts, type QueryRecord } from '@cadrel/kernel';
import { LocalVault, DirBlobs } from '@cadrel/store';
import { ACCOUNT, TOKEN, fakeCloudflare } from './fakeCloudflare';
import { buildStudio } from '../src/main/cloudflare';
import { joinStudio, StudioClient, StudioOfflineError } from '../src/main/studioClient';
import { EditorialOffline } from '../src/main/offlineEditorial';
import { OfflineAwareStore, RemoteBlobs, RemoteVaultStore, remoteService } from '../src/main/remote';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const tmp = async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'cadrel-m3-'));
  dirs.push(d);
  return d;
};

const PROJECT = 'pBook';
const TREE = { projects: [{ id: PROJECT, name: 'Lead Me', parentId: null, kind: 'Book', status: 'active' as const, order: 0, workflowId: null, stage: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }], links: [] };

/** A Studio built in the stand-in Cloudflare, with the owner and a way to bring people in, and a switch that cuts the network. */
async function studio() {
  const cf = fakeCloudflare();
  const ownerKey = await generateKeyPair();
  const built = await buildStudio({ fetchFn: cf.fetchFn, sleep: async () => undefined }, { accountId: ACCOUNT, apiToken: TOKEN, studioId: 'sabc123def4', ownerKey: ownerKey.publicKey, workerSource: '// server' });
  let online = true;
  const fetchFn = (async (i: string | URL | Request, init?: RequestInit) => (online ? cf.fetchFn(i, init) : Promise.reject(new TypeError('offline')))) as typeof fetch;
  // The app keeps the answers to its reads for a few seconds and asks the Studio's change counter after that. One clock for every person's client, moved on by
  // `advance`, is how a test that watches several people at once sees what the others just did.
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const owner = new StudioClient({ url: built.url, key: ownerKey, fetchFn, now });
  /** `wholeStudio`: the role applies to every project (a Series Lead); otherwise to this book, for a while (an Author, an Editor). */
  const person = async (role: string, name: string, wholeStudio = false) => {
    const { link } = await owner.invite(role, name, 'Acme', wholeStudio ? {} : { projectId: PROJECT, days: 60 });
    const j = await joinStudio({ link, yourName: name, fetchFn });
    return new StudioClient({ url: built.url, key: j.key, fetchFn, now });
  };
  return { owner, person, advance: () => (clock.t += 10_000), setOnline: (on: boolean) => (online = on) };
}

/** One person's computer: a working folder and the vault over the server. */
async function computer(client: StudioClient, machine: string) {
  const root = await tmp();
  const me = await client.me();
  const store = new OfflineAwareStore(new RemoteVaultStore(client), path.join(root, 'cache.json'));
  const vault = new LocalVault({ store, blobs: new RemoteBlobs(client, new DirBlobs(path.join(root, 'blobs'))), dir: path.join(root, 'work'), personId: me.personId, machine });
  await (await import('node:fs/promises')).mkdir(path.join(root, 'work'), { recursive: true });
  const file = (rel: string) => path.join(root, 'work', rel);
  return { vault, me, root, write: (rel: string, text: string) => writeFile(file(rel), text), read: (rel: string) => readFile(file(rel), 'utf8') };
}

// ---- the book ----------------------------------------------------------------------------------------------------------------

const BOOK = [
  '# Lead Me',
  'Mara left the village at dawn. She walked slowly along the river, and the water ran cold beside her.',
  'Nobody saw her go, which was the point. The bells did not ring, and the dogs did not bark.',
  'By noon she had reached the ford. She stood there for a long time, watching the current, and wondered whether she should go back.',
  'It was a decision that had been made for her years ago, in a kitchen, over a table, by people who loved her and were wrong.',
  'She crossed. The far bank was mud and reeds, and she was glad of it, because it asked nothing of her.',
  'That night she slept in a barn, and dreamt of the bells.'
].join('\n\n');

/** One edit in a round: the passage it is about, the replacement, what the Author decides, and whether the Author's revision makes it. */
interface Change {
  quote: string;
  replacement: string;
  decision: { outcome: 'accept' | 'reject' | 'defer'; reason?: string; revisit?: string };
  made: boolean;
}
/** Replaces the first occurrence of each made change in the text. */
const apply = (text: string, changes: Change[]) => changes.filter((c) => c.made).reduce((t, c) => t.replace(c.quote, c.replacement), text);

const ROUNDS: { kind: 'developmental' | 'line' | 'copy'; query: string; answer: string; changes: Change[]; comment: string }[] = [
  {
    kind: 'developmental',
    query: 'Why does she not tell anyone she is leaving?',
    answer: 'Because the village would stop her. It is the whole point of the opening.',
    changes: [
      { quote: 'Nobody saw her go, which was the point.', replacement: 'Nobody saw her go, and she had made sure of it.', decision: { outcome: 'accept' }, made: true },
      { quote: 'and wondered whether she should go back.', replacement: 'and did not let herself wonder whether to go back.', decision: { outcome: 'accept' }, made: false }, // accepted, but the Author misses it
      { quote: 'by people who loved her and were wrong.', replacement: 'by people who loved her.', decision: { outcome: 'reject', reason: 'The “wrong” is the point of the sentence.' }, made: false },
      { quote: 'That night she slept in a barn, and dreamt of the bells.', replacement: 'That night she slept in a barn.', decision: { outcome: 'defer', reason: 'Wait for the beta readers.', revisit: '2026-12-15' }, made: false }
    ],
    comment: 'The opening is strong. The second half of the chapter coasts.'
  },
  {
    kind: 'line',
    query: 'Is the river cold, or is she?',
    answer: 'The river. She is past feeling it.',
    changes: [
      { quote: 'She walked slowly along the river', replacement: 'She crept along the river', decision: { outcome: 'accept' }, made: true },
      { quote: 'The far bank was mud and reeds', replacement: 'The far bank was only mud and reeds', decision: { outcome: 'accept' }, made: true },
      { quote: 'for a long time', replacement: 'a long while', decision: { outcome: 'reject', reason: 'Keeps the rhythm.' }, made: false }
    ],
    comment: 'Watch “the water ran”: it recurs.'
  },
  {
    kind: 'copy',
    query: 'Should “dreamt” be “dreamed”?',
    answer: 'Dreamt: it is a British-spelling book.',
    changes: [
      { quote: 'and the dogs did not bark', replacement: 'and the dogs did not bark either', decision: { outcome: 'accept' }, made: true },
      { quote: 'in a kitchen, over a table', replacement: 'in a kitchen, across a table', decision: { outcome: 'accept' }, made: true }
    ],
    comment: 'Consistent. Nothing else to flag.'
  }
];

describe('M3 exit test: one book goes through a full edit inside Cadrel', () => {
  it('developmental, line and copy edits, with the Author offline for the first, a missed change flagged, and a gate that opens only when all three are closed', async () => {
    const s = await studio();
    await s.owner.publishTree(TREE);
    const owner = remoteService(s.owner).as('x');

    // ---- the people: each is a real role; the Author and the Editor are given this book, the Series Lead the studio
    const annClient = await s.person('author', 'Ann Author');
    const eveClient = await s.person('editor', 'Eve Editor');
    const leaClient = await s.person('series_lead', 'Lena Lead', true); // a Series Lead holds the whole studio ...
    await owner.people.grant({ subject: { kind: 'person', id: (await leaClient.me()).personId }, roleId: 'role_series_lead', scope: { kind: 'project', id: PROJECT } }); // ... and is assigned to the books she leads
    const ann = remoteService(annClient).as('x');
    const eve = remoteService(eveClient).as('x');
    const lea = remoteService(leaClient).as('x');

    // ---- the manuscript, in the vault: the Owner adds it to the book; the Author owns the revisions
    const PATH = 'book.md';
    const ownerPc = await computer(s.owner, 'owner-pc');
    const annPc = await computer(annClient, 'ann-pc');
    const evePc = await computer(eveClient, 'eve-pc');
    await ownerPc.write(PATH, BOOK);
    await ownerPc.vault.add(PATH, 'First draft');
    await ownerPc.vault.setCard(PATH, {}, PROJECT);
    const fileId = (await ownerPc.vault.status(PATH)).fileId!;
    const textOf = async (pc: typeof evePc, n: number) => new TextDecoder().decode(await pc.vault.read(PATH, n));
    expect(await textOf(evePc, 1)).toBe(BOOK); // the Editor reads exactly what the Owner added

    // ---- the gate: Editing → Published asks for all three closed passes and every query answered
    const base = (await owner.workflows.list())[0]!;
    const wf = await owner.workflows.create({ name: 'Edited before publishing' });
    await owner.workflows.save(wf.id, {
      name: wf.name,
      description: '',
      stages: base.stages.map((st) => ({ key: st.key, name: st.name, category: st.category, color: st.color })),
      transitions: [{ from: 'editing', to: 'published', roleIds: [], conditions: [{ kind: 'pass_closed', passKind: 'developmental' }, { kind: 'pass_closed', passKind: 'line' }, { kind: 'pass_closed', passKind: 'copy' }, { kind: 'queries_resolved' }] }]
    } as never);
    const gate = async () => {
      s.advance(); // what the others just did
      const facts: ProjectFacts = { hasManuscript: true, openNotes: 0, subprojects: [], openTasks: 0, approved: [], editorial: await lea.work.editorialFacts([PROJECT]) };
      const r = await lea.workflows.stageOptions(wf.id, 'editing', facts);
      return r.options.find((o) => o.key === 'published')!;
    };
    expect((await gate()).allowed).toBe(false);

    // ---- the three rounds
    let version = 1;
    let text = BOOK;
    const passIds: string[] = [];
    const deferredTasks: string[] = [];
    for (const [round, R] of ROUNDS.entries()) {
      const first = round === 0;

      // the Editor plans, starts and raises items on the exact version of the manuscript
      const planned = await eve.passes.create({ projectId: PROJECT, kind: R.kind, fileId, editorId: (await eveClient.me()).personId });
      expect(planned).toMatchObject({ state: 'planned', fileVersion: version, kind: R.kind });
      passIds.push(planned.id);
      await eve.passes.start(planned.id);
      const pinned = await textOf(evePc, version);
      expect(pinned).toBe(text);
      const at = (quote: string) => {
        const start = pinned.indexOf(quote);
        expect(start, `“${quote}” is in version ${version}`).toBeGreaterThan(-1);
        return makeAnchor(pinned, start, start + quote.length);
      };
      const raised = await eve.queries.raise(planned.id, [
        { kind: 'query', body: R.query, anchor: at(R.changes[0]!.quote) },
        ...R.changes.map((c) => ({ kind: 'suggestion' as const, body: '', anchor: at(c.quote), replacement: c.replacement })),
        { kind: 'comment' as const, body: R.comment }
      ]);
      expect(raised.map((r2) => r2.seq)).toEqual(raised.map((_, i) => i + 1));
      const query = raised[0]!;
      const suggestions = raised.slice(1, 1 + R.changes.length);
      await eve.passes.deliver(planned.id);

      // the gate does not open while a pass is under way, and says what is missing
      const held = await gate();
      expect(held.allowed).toBe(false);
      expect(held.reasons.join(' ')).toMatch(/still unanswered|still under way|Needs a closed/);

      // the Author sees what waits on them, and cannot answer the pass until every query is answered and every suggestion decided
      const mine = async (api = ann) => (s.advance(), await api.passes.list()).find((p) => p.id === planned.id)!;
      expect((await mine()).state).toBe('delivered');
      await expect(ann.passes.respond(planned.id)).rejects.toThrow(/1 query is still unanswered/);

      // round one is made on a computer with no connection: the answers wait, are shown as made, and are sent in order when the Studio is back
      const author = first ? new EditorialOffline(remoteService(annClient), { file: path.join(annPc.root, 'editorial-offline.json') }).as('x') : ann;
      if (first) {
        await author.queries.list({ passId: planned.id }); // read while connected: the copy this computer keeps
        s.setOnline(false);
        const kept = await author.queries.list({ passId: planned.id });
        expect(kept.map((i) => i.id)).toEqual(raised.map((i) => i.id));
      }
      await author.queries.answer(query.id, R.answer);
      for (const [i, c] of R.changes.entries()) await author.queries.decide(suggestions[i]!.id, c.decision);
      if (first) {
        const shown = (await author.queries.list({ passId: planned.id })).find((i) => i.id === query.id)!;
        expect(shown).toMatchObject({ state: 'answered', response: R.answer }); // their own work, while they cannot reach the Studio
        await expect(author.passes.respond(planned.id)).rejects.toBeInstanceOf(StudioOfflineError); // moving the pass along needs the server
        s.setOnline(true);
      }
      // (the first round's answers are still only on Ann's computer: send them now)
      if (first) {
        const wrapper = new EditorialOffline(remoteService(annClient), { file: path.join(annPc.root, 'editorial-offline.json') });
        expect((await wrapper.status()).pending).toBe(R.changes.length + 1);
        expect(await wrapper.flush()).toEqual({ offline: false });
        expect(await wrapper.status()).toMatchObject({ pending: 0, refused: [] });
      }
      s.advance();
      const answered = (await eve.queries.list({ passId: planned.id })).find((i) => i.id === query.id)!;
      expect(answered).toMatchObject({ state: 'answered', response: R.answer });
      await ann.passes.respond(planned.id);

      // what the Author decided is on the record: one decision per suggestion, a ledger entry for each, and a task for the deferral
      s.advance();
      const decisions = await eve.queries.decisions({ passId: planned.id });
      expect(decisions.map((d) => d.outcome).sort()).toEqual(R.changes.map((c) => c.decision.outcome).sort());
      const ledger = await owner.work.decisions({ projectIds: [PROJECT] });
      for (const d of decisions) expect(ledger.some((l) => l.id === d.ledgerId)).toBe(true);
      for (const d of decisions.filter((x) => x.outcome === 'defer')) {
        const t = await owner.work.task(d.taskId!);
        expect(t).toMatchObject({ state: 'open', due: R.changes.find((c) => c.decision.outcome === 'defer')!.decision.revisit });
        deferredTasks.push(t!.id);
      }

      // the Author revises the manuscript in the vault: checks it out, makes the accepted changes (not the one they miss), checks it in
      const next = apply(text, R.changes.filter((c) => c.decision.outcome === 'accept'));
      await annPc.vault.checkOut(PATH);
      await annPc.write(PATH, next);
      const checkedIn = await annPc.vault.checkIn(PATH, `After the ${R.kind} edit`);
      expect(checkedIn.unchanged).toBe(false);
      version += 1;
      text = next;
      expect((await mine()).fileVersion).toBe(version - 1); // the pass still covers the version the Editor was shown

      // the Editor compares the two versions, and checks the revision: what was made is made, and the missed change is flagged
      const [before, after] = [await textOf(evePc, version - 1), await textOf(evePc, version)];
      const cmp = compareTexts(before, after);
      expect(cmp.stats.changed).toBe(R.changes.filter((c) => c.decision.outcome === 'accept' && c.made).length);
      expect(cmp.stats.added + cmp.stats.removed).toBe(0);
      const checks = await eve.queries.verify(planned.id, { revisedVersion: version, revisedText: after });
      const byItem = (id: string) => checks.find((c) => c.queryId === id)!;
      R.changes.forEach((c, i) => {
        if (c.decision.outcome !== 'accept') expect(checks.some((k) => k.queryId === suggestions[i]!.id)).toBe(false); // only what was accepted is checked
        else expect(byItem(suggestions[i]!.id).result, `${R.kind}: “${c.quote}”`).toBe(c.made ? 'made' : 'missed');
      });
      const missed = R.changes.filter((c) => c.decision.outcome === 'accept' && !c.made).length;
      expect(checks.filter((c) => c.result === 'missed')).toHaveLength(missed);

      // the Author cannot close the pass (they may read and respond, not approve); the Series Lead can
      await expect(ann.passes.close(planned.id)).rejects.toThrow(/edit\.approve/);
      await lea.passes.close(planned.id);
      expect((await lea.passes.get(planned.id))!.state).toBe('closed');

      // the gate is open only when the last of the three is closed
      const g = await gate();
      expect(g.allowed, `after the ${R.kind} edit`).toBe(round === ROUNDS.length - 1);
      if (!g.allowed) expect(g.reasons.join(' ')).toMatch(/Needs a closed/);
    }

    // ---- the whole edit is on the record
    expect(version).toBe(1 + ROUNDS.length);
    expect((await owner.passes.list({ state: 'closed' })).map((p) => p.kind).sort()).toEqual(['copy', 'developmental', 'line']);
    expect(deferredTasks).toHaveLength(1); // the one deferral of the developmental edit
    expect((await annPc.vault.history(PATH)).map((v) => v.comment)).toEqual(['After the copy edit', 'After the line edit', 'After the developmental edit', 'First draft']);

    // ---- a proofread only advises: a live one does not close the gate, and a gate cannot ask for one
    const proof = await eve.passes.create({ projectId: PROJECT, kind: 'proof', fileId, editorId: (await eveClient.me()).personId });
    await eve.passes.start(proof.id);
    expect((await gate()).allowed).toBe(true);
    await expect(owner.workflows.save(wf.id, { name: wf.name, description: '', stages: base.stages.map((st) => ({ key: st.key, name: st.name, category: st.category, color: st.color })), transitions: [{ from: 'editing', to: 'published', roleIds: [], conditions: [{ kind: 'pass_closed', passKind: 'proof' }] }] } as never)).rejects.toThrow(/proofread only advises/);

    // ---- and a query left unanswered would hold the gate: a new round's query, raised and not yet answered
    await eve.passes.cancel(proof.id).catch(() => undefined);
    const again = await eve.passes.create({ projectId: PROJECT, kind: 'copy', fileId, editorId: (await eveClient.me()).personId });
    await eve.passes.start(again.id);
    await eve.queries.raise(again.id, [{ kind: 'query', body: 'One more thing.' }]);
    await eve.passes.deliver(again.id);
    const reopened = await gate();
    expect(reopened.allowed).toBe(false); // a new copy edit is under way, and its query is unanswered
    expect(reopened.reasons.join(' ')).toMatch(/still unanswered/);
  }, 120_000);
});
