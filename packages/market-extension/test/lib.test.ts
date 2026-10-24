import { describe, expect, it } from 'vitest';
import { asinOf, decideSample, sessionId, signatureDistance, classifyUrl, wantsAutoCapture, withoutHash, describeResult, extForType, extractCoverUrl, isImageHost, toBase64, isCaptureQuotaError, shotWait, SHOT_GAP_MS } from '../src/lib.js';

describe('classifyUrl', () => {
  it('classifies amazon.com pages', () => {
    expect(classifyUrl('https://www.amazon.com/Title/dp/B0G7R6X55V/ref=zg')).toBe('detail');
    expect(classifyUrl('https://www.amazon.com/gp/product/B0G7R6X55V')).toBe('detail');
    expect(classifyUrl('https://www.amazon.com/Best-Sellers-Kindle-Store/zgbs/digital-text/11650864011?pg=2')).toBe('list');
    expect(classifyUrl('https://www.amazon.com/gp/bestsellers/digital-text/11650864011')).toBe('list');
    expect(classifyUrl('https://www.amazon.com/s?k=dragons&i=digital-text')).toBe('search');
  });
  it('refuses everything else', () => {
    expect(classifyUrl('https://www.amazon.com/s?i=digital-text')).toBeNull();
    expect(classifyUrl('https://www.amazon.com.au/dp/B0G7R6X55V')).toBeNull();
    expect(classifyUrl('http://www.amazon.com/dp/B0G7R6X55V')).toBeNull();
    expect(classifyUrl('https://evil.example/www.amazon.com/dp/B0G7R6X55V')).toBeNull();
    expect(classifyUrl('not a url')).toBeNull();
  });
});

describe('cover helpers', () => {
  it('finds the hi-res url, unescaping slashes', () => {
    expect(extractCoverUrl('x "hiRes":"https:\\/\\/m.media-amazon.com\\/images\\/I\\/abc._SL1500_.jpg" y')).toBe(
      'https://m.media-amazon.com/images/I/abc._SL1500_.jpg',
    );
    expect(extractCoverUrl('<img data-old-hires="https://m.media-amazon.com/images/I/z.jpg">')).toBe('https://m.media-amazon.com/images/I/z.jpg');
    expect(extractCoverUrl('<html></html>')).toBeNull();
  });
  it('only fetches from amazon image hosts over https', () => {
    expect(isImageHost('https://m.media-amazon.com/images/I/a.jpg')).toBe(true);
    expect(isImageHost('http://m.media-amazon.com/images/I/a.jpg')).toBe(false);
    expect(isImageHost('https://m.media-amazon.com.evil.example/a.jpg')).toBe(false);
    expect(isImageHost('https://127.0.0.1/a.jpg')).toBe(false);
  });
  it('maps content types and encodes bytes', () => {
    expect(extForType('image/png')).toBe('png');
    expect(extForType('image/jpeg')).toBe('jpg');
    expect(toBase64(new Uint8Array([104, 105]).buffer)).toBe('aGk=');
    expect(toBase64(new Uint8Array(100000).buffer).length).toBeGreaterThan(100000);
  });
});

describe('describeResult', () => {
  it('summarises success and failure', () => {
    expect(describeResult({ ok: true, kind: 'detail', asin: 'B0G7R6X55V' })).toEqual({ badge: '✓', title: 'Saved book B0G7R6X55V' });
    expect(describeResult({ ok: true, kind: 'detail', asin: 'B0G7R6X55V', replaced: true }).title).toContain('replaced');
    expect(describeResult({ ok: true, kind: 'search', query: 'cozy fantasy' }).title).toBe('Saved search "cozy fantasy"');
    expect(describeResult({ ok: false, error: 'bad token' })).toEqual({ badge: '!', title: 'bad token' });
  });
});

describe('sample capture decisions', () => {
  const sig = (v: number) => new Uint8Array(100).fill(v);
  const start = { lastSaved: null as Uint8Array | null, pending: null as Uint8Array | null };

  it('measures how different two looks are', () => {
    expect(signatureDistance(sig(10), sig(10))).toBe(0);
    expect(signatureDistance(sig(10), sig(40))).toBe(30);
    expect(signatureDistance(sig(10), new Uint8Array(5))).toBe(Infinity);
    expect(signatureDistance(null, sig(1))).toBe(Infinity);
  });

  it('saves a page only after it has changed and then settled', () => {
    let s = start;
    let d = decideSample(s, sig(50)); // first look at a page
    expect(d.save).toBe(false);
    d = decideSample(d.state, sig(50)); // still the same: settled
    expect(d.save).toBe(true);
    s = d.state;
    expect(decideSample(s, sig(50)).save).toBe(false); // same page again: nothing new
    d = decideSample(s, sig(120)); // page turn begins
    d = decideSample(d.state, sig(90)); // animation in progress: not settled
    expect(d.save).toBe(false);
    d = decideSample(d.state, sig(90));
    expect(d.save).toBe(true);
    expect(d.state.lastSaved).toEqual(sig(90));
  });

  it('ignores tiny changes such as a blinking cursor or sub-pixel noise', () => {
    let d = decideSample(decideSample(start, sig(50)).state, sig(50));
    expect(d.save).toBe(true);
    d = decideSample(d.state, sig(51));
    expect(d.save).toBe(false);
  });

  it('does nothing while the reader is not on screen', () => {
    const d = decideSample({ lastSaved: sig(50), pending: sig(60) }, null);
    expect(d.save).toBe(false);
    expect(d.state.pending).toBeNull();
  });

  it('makes session ids and finds ASINs', () => {
    expect(sessionId(new Date('2026-10-19T10:00:00.123Z'))).toBe('20261019T100000Z');
    expect(asinOf('https://www.amazon.com/Some-Title/dp/B0G7R6X55V/ref=x')).toBe('B0G7R6X55V');
    expect(asinOf('https://www.amazon.com/s?k=x')).toBeNull();
  });
});

describe('screenshot rate', () => {
  it('spaces screenshots at least SHOT_GAP_MS apart, staying under Chrome\'s two-per-second limit', () => {
    expect(SHOT_GAP_MS).toBeGreaterThanOrEqual(500);
    expect(shotWait(undefined, 1000)).toBe(0);
    expect(shotWait(1000, 1000)).toBe(SHOT_GAP_MS);
    expect(shotWait(1000, 1000 + SHOT_GAP_MS - 100)).toBe(100);
    expect(shotWait(1000, 1000 + SHOT_GAP_MS)).toBe(0);
    expect(shotWait(1000, 5000)).toBe(0);
  });
  it('recognises Chrome\'s quota refusal', () => {
    expect(isCaptureQuotaError('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.')).toBe(true);
    expect(isCaptureQuotaError('Cannot access contents of the page')).toBe(false);
    expect(isCaptureQuotaError(undefined)).toBe(false);
  });
});

describe('auto capture', () => {
  it('only fires for tagged amazon search pages', () => {
    expect(wantsAutoCapture('https://www.amazon.com/s?k=cozy+fantasy&i=digital-text#bookscout-capture')).toBe(true);
    expect(wantsAutoCapture('https://www.amazon.com/s?k=cozy+fantasy&i=digital-text')).toBe(false);
    expect(wantsAutoCapture('https://www.amazon.com/dp/B0G7R6X55V#bookscout-capture')).toBe(false);
    expect(wantsAutoCapture('https://evil.example/s?k=x#bookscout-capture')).toBe(false);
  });
  it('strips the fragment', () => {
    expect(withoutHash('https://www.amazon.com/s?k=a#bookscout-capture')).toBe('https://www.amazon.com/s?k=a');
    expect(withoutHash('https://www.amazon.com/s?k=a')).toBe('https://www.amazon.com/s?k=a');
  });
});
