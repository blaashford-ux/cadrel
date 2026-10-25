import { describe, expect, it } from 'vitest';
import { detectPersonalLiterals, parseDetailPage, parseListPage, scrub } from '../src/index.js';
import { DETAIL_ASINS, detailFixture, fixture } from './fixtures.js';

const PLANTED = {
  name: 'Zelda',
  city: 'Fakeville 9000',
  country: 'Atlantis',
  session: '111-2222222-3333333',
  clientId: '1234567-7654321-1234567',
  customer: 'A1FAKEFAKE12X',
  hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  csrf: 'tokenTOKENtoken123',
};

const page = `<!doctype html><html><head><title>t</title>
<link rel="canonical" href="https://www.amazon.com/x/dp/B000000001">
<div data-props="{&quot;clientId&quot;:&quot;${PLANTED.clientId}&quot;}"></div>
<script>window.ue_sid='${PLANTED.session}'; customerId: '${PLANTED.customer}'</script>
<script>var data = {'colorImages': {'initial': [{"hiRes":"https://m.media-amazon.com/images/I/abc._SL1500_.jpg"}]}};</script>
<style>.a{color:red}</style></head><body>
<span id="glow-ingress-line1">Deliver to ${PLANTED.name}</span><span id="glow-ingress-line2">${PLANTED.city}&zwnj;</span>
<span id="nav-link-accountList-nav-line-1">Hello, ${PLANTED.name}</span>
<script>$Nav.declare('config.customerName','${PLANTED.name}');$Nav.declare('config.hashCustomerAndSessionId','${PLANTED.hash}');</script>
<input name="glow-validation-token" type="hidden" value="${PLANTED.csrf}"/>
<a href="/dp/B000000001/ref=x/${PLANTED.session}?psc=1">book</a>
<a href="/customer-preferences/edit?preferencesReturnUrl=%2Fdp%2FB000000001%2Fref%3Dx%2F${PLANTED.session}" id="icp">encoded</a>
<iframe data-src="https://read.amazon.com/sample/B000000001?sid=${PLANTED.session}&cid=${PLANTED.customer}&rid=ABC"></iframe>
<div>FREE delivery to ${PLANTED.country} on <span>$49</span> of eligible items</div>
<h1 id="productTitle">The Book</h1>
<div>A reviewer wrote that ${PLANTED.name} is a fine name for a character.</div>
</body></html>`;

describe('scrub', () => {
  const out = scrub(page);
  it('removes every planted personal value', () => {
    for (const v of Object.values(PLANTED)) expect(out, v).not.toContain(v);
  });
  it('keeps the book data and the cover blob', () => {
    expect(out).toContain('<h1 id="productTitle">The Book</h1>');
    expect(out).toContain('"hiRes":"https://m.media-amazon.com/images/I/abc._SL1500_.jpg"');
    expect(out).toContain('/dp/B000000001');
  });
  it('drops script bodies that hold ids', () => {
    expect(out).not.toContain('ue_sid');
    expect(out).not.toContain('hashCustomerAndSessionId');
  });
  it('detects the literals from the page itself', () => {
    const lits = detectPersonalLiterals(page);
    expect(lits).toEqual(expect.arrayContaining([PLANTED.name, PLANTED.customer, PLANTED.hash]));
  });
  it('is idempotent', () => expect(scrub(out)).toBe(out));
});

describe('committed fixtures contain no personal data', () => {
  const files = [...DETAIL_ASINS.map((a) => `amazon-com/detail-kindle-${a}.html.gz`), 'amazon-com/bestsellers-kindle-humorous-fantasy.html.gz',
    'amazon-com/bestsellers-kindle-cozy-fantasy.excerpt.html', 'amazon-com-au/bestsellers-books-humorous-fantasy.html', 'amazon-com-au/bestsellers-kindle-cozy-fantasy.html'];
  for (const f of files) {
    it(f, () => {
      const t = fixture(f);
      for (const m of t.matchAll(/\d{3,7}-\d{7}-\d{7}/g)) expect(m[0]).toMatch(/^0+-0+-0+$/);
      expect(detectPersonalLiterals(t)).toEqual([]);
    });
  }
});

describe('scrubbing never changes what the parsers read', () => {
  it('list page', () => {
    const raw = fixture('amazon-com/bestsellers-kindle-humorous-fantasy.html.gz');
    expect(parseListPage(scrub(raw))).toEqual(parseListPage(raw));
  });
  it('detail page', () => {
    const raw = detailFixture('B0HC7ZDQQ8');
    expect(parseDetailPage(scrub(raw))).toEqual(parseDetailPage(raw));
  });
});
