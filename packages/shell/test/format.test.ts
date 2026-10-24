import { describe, expect, it } from 'vitest';
import { ago, formatWords, greeting, percent } from '../src/renderer/format';

describe('format', () => {
  const now = Date.UTC(2026, 9, 24, 12, 0, 0);
  it('words get thousands separators', () => {
    expect(formatWords(0)).toBe('0');
    expect(formatWords(81234)).toBe('81,234');
  });
  it('ago reads naturally and handles never', () => {
    expect(ago(null, now)).toBe('not started');
    expect(ago(now - 5_000, now)).toBe('just now');
    expect(ago(now - 60_000, now)).toBe('1 minute ago');
    expect(ago(now - 3 * 3600_000, now)).toBe('3 hours ago');
    expect(ago(now - 2 * 86400_000, now)).toBe('2 days ago');
    expect(ago(now - 90 * 86400_000, now)).toBe('3 months ago');
    expect(ago(now + 1000, now)).toBe('just now');
  });
  it('percent is null without a goal and capped at 100', () => {
    expect(percent(10, null)).toBeNull();
    expect(percent(10, 0)).toBeNull();
    expect(percent(25000, 100000)).toBe(25);
    expect(percent(150000, 100000)).toBe(100);
  });
  it('greeting follows the hour', () => {
    expect([2, 9, 14, 21].map(greeting)).toEqual(['Working late', 'Good morning', 'Good afternoon', 'Good evening']);
  });
});
