import type { BookDetails } from './model';

/** Format-neutral content for the pages around the chapters. Each builder renders these its own way. */
export type PageBlock =
  | { t: 'title' | 'subtitle' | 'author'; text: string }
  | { t: 'heading'; text: string }
  | { t: 'line'; text: string; bold?: boolean }
  | { t: 'para'; text: string; bold?: boolean; italic?: boolean; align?: 'left' | 'center' | 'right' }
  | { t: 'link'; label: string; url: string };

export interface MatterPage {
  id: 'title' | 'copyright' | 'dedication' | 'epigraph' | 'links' | 'alsoBy' | 'about' | 'custom';
  /** Back-matter pages appear in the table of contents under this heading. */
  heading?: string;
  blocks: PageBlock[];
}

/** Only web and mail links are ever emitted. Anything else is dropped (and reported). */
export function safeUrl(url: string): string {
  const u = url.trim();
  return /^(https?:\/\/|mailto:)\S+$/i.test(u) ? u : '';
}

const paragraphs = (text: string) =>
  text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.replace(/\s*\r?\n\s*/g, ' ').trim())
    .filter(Boolean);

export function buildFrontMatter(d: BookDetails): MatterPage[] {
  const pages: MatterPage[] = [];
  const c = d.copyright;

  const title: PageBlock[] = [{ t: 'title', text: d.title }];
  if (d.subtitle.trim()) title.push({ t: 'subtitle', text: d.subtitle });
  title.push({ t: 'author', text: d.author });
  pages.push({ id: 'title', blocks: title });

  // Copyright page — the order is fixed (see the format-for-kdp skill).
  const cr: PageBlock[] = [
    { t: 'line', text: d.title },
    { t: 'line', text: `Copyright © ${c.year.trim()} by ${d.author}`.replace('©  by', '© by') },
    { t: 'line', text: 'All rights reserved.' }
  ];
  if (c.fictionDisclaimer && c.fictionText.trim()) cr.push({ t: 'para', text: c.fictionText.trim() });
  if (c.reproductionText.trim()) cr.push({ t: 'para', text: c.reproductionText.trim() });
  if (c.matureNotice && c.matureText.trim()) cr.push({ t: 'para', text: c.matureText.trim(), bold: true });
  if (c.contentWarning && c.contentWarningText.trim()) cr.push({ t: 'para', text: c.contentWarningText.trim() });
  if (c.publisher.trim()) cr.push({ t: 'line', text: `Published by ${c.publisher.trim()}` });
  if (c.isbn.trim()) cr.push({ t: 'line', text: `ISBN: ${c.isbn.trim()}` });
  for (const l of c.extraLines) if (l.trim()) cr.push({ t: 'line', text: l.trim() });
  if (c.edition.trim()) cr.push({ t: 'line', text: c.edition.trim() });
  pages.push({ id: 'copyright', blocks: cr });

  if (d.dedication.enabled && d.dedication.text.trim()) {
    pages.push({
      id: 'dedication',
      blocks: paragraphs(d.dedication.text).map((text) => ({ t: 'para' as const, text, italic: true, align: 'center' as const }))
    });
  }
  if (d.epigraph.enabled && d.epigraph.text.trim()) {
    const blocks: PageBlock[] = paragraphs(d.epigraph.text).map((text) => ({ t: 'para' as const, text, italic: true, align: 'center' as const }));
    if (d.epigraph.attribution.trim()) blocks.push({ t: 'para', text: `— ${d.epigraph.attribution.trim()}`, align: 'center' });
    pages.push({ id: 'epigraph', blocks });
  }
  return pages;
}

export function buildBackMatter(d: BookDetails, warnings: string[]): MatterPage[] {
  const pages: MatterPage[] = [];
  const checked = (url: string, what: string): string => {
    if (!url.trim()) return '';
    const ok = safeUrl(url);
    if (!ok) warnings.push(`The link for “${what}” (${url.trim().slice(0, 60)}) isn’t a web or email address, so it was left out.`);
    return ok;
  };

  const links = d.back.links;
  if (links.enabled) {
    const heading = links.heading.trim() || 'CONTINUE THE STORY';
    const blocks: PageBlock[] = [{ t: 'heading', text: heading }];
    for (const p of paragraphs(links.intro)) blocks.push({ t: 'para', text: p });
    for (const it of links.items) {
      const url = checked(it.url, it.label || '(unlabelled)');
      if (it.label.trim() && url) blocks.push({ t: 'link', label: it.label.trim(), url });
      else if (it.label.trim() && !it.url.trim()) blocks.push({ t: 'line', text: it.label.trim() });
    }
    pages.push({ id: 'links', heading, blocks });
  }

  const also = d.back.alsoBy;
  if (also.enabled && also.items.some((i) => i.title.trim())) {
    const heading = also.heading.trim() || `ALSO BY ${d.author.toUpperCase()}`;
    const blocks: PageBlock[] = [{ t: 'heading', text: heading }];
    for (const it of also.items) {
      if (!it.title.trim()) continue;
      const url = checked(it.url, it.title);
      blocks.push(url ? { t: 'link', label: it.title.trim(), url } : { t: 'line', text: it.title.trim() });
    }
    pages.push({ id: 'alsoBy', heading, blocks });
  }

  const about = d.back.about;
  if (about.enabled && about.text.trim()) {
    const heading = about.heading.trim() || 'ABOUT THE AUTHOR';
    pages.push({
      id: 'about',
      heading,
      blocks: [{ t: 'heading', text: heading }, ...paragraphs(about.text).map((text) => ({ t: 'para' as const, text }))]
    });
  }

  const custom = d.back.custom;
  if (custom.enabled && custom.text.trim()) {
    const heading = custom.heading.trim();
    pages.push({
      id: 'custom',
      heading: heading || undefined,
      blocks: [...(heading ? [{ t: 'heading' as const, text: heading }] : []), ...paragraphs(custom.text).map((text) => ({ t: 'para' as const, text }))]
    });
  }
  return pages;
}
