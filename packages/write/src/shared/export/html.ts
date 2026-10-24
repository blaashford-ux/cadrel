import type { BuiltChapter } from './assemble';
import type { Block, Inline } from './manuscript';
import type { MatterPage, PageBlock } from './matter';
import { safeUrl } from './matter';

/** XML/HTML text escaping. Also drops characters that are illegal in XML 1.0. */
export function esc(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  );
}

export type Medium = 'ebook' | 'print';

export function inlinesHtml(inlines: Inline[], medium: Medium): string {
  return inlines
    .map((i) => {
      switch (i.t) {
        case 'text':
          return esc(i.text);
        case 'em':
          return `<em>${inlinesHtml(i.children, medium)}</em>`;
        case 'strong':
          return `<strong>${inlinesHtml(i.children, medium)}</strong>`;
        case 'code':
          return `<code>${esc(i.text)}</code>`;
        case 'br':
          return '<br/>';
        case 'link': {
          const inner = inlinesHtml(i.children, medium);
          const url = safeUrl(i.url);
          // Print can't be clicked: show the words only. Ebooks get a real link (web/mail only).
          return medium === 'ebook' && url ? `<a href="${esc(url)}">${inner}</a>` : inner;
        }
      }
    })
    .join('');
}

export function blocksHtml(blocks: Block[], medium: Medium, sceneBreak: string): string {
  let prev: Block['t'] | null = null; // first paragraph after a heading / scene break has no indent
  const out: string[] = [];
  for (const b of blocks) {
    const first = prev === null || prev === 'scene' || prev === 'sub';
    switch (b.t) {
      case 'para':
        out.push(`<p${first ? ' class="first"' : ''}>${inlinesHtml(b.inlines, medium)}</p>`);
        break;
      case 'sub':
        out.push(`<h${b.level} class="sub">${inlinesHtml(b.inlines, medium)}</h${b.level}>`);
        break;
      case 'scene':
        out.push(`<p class="scenebreak">${esc(sceneBreak)}</p>`);
        break;
      case 'quote':
        out.push(`<blockquote>${blocksHtml(b.blocks, medium, sceneBreak)}</blockquote>`);
        break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${b.items.map((it) => `<li>${blocksHtml(it, medium, sceneBreak).replace(/^<p( class="first")?>([\s\S]*?)<\/p>$/, '$2')}</li>`).join('')}</${tag}>`);
        break;
      }
      case 'code':
        out.push(`<pre>${esc(b.text)}</pre>`);
        break;
    }
    prev = b.t;
  }
  return out.join('\n');
}

/** The chapter heading with its italic subtitle part, as inner HTML. */
export function chapterHeadingHtml(c: BuiltChapter): string {
  const h = c.heading;
  return h.rest ? `${esc(h.prefix)}: <em>${esc(h.rest)}</em>` : esc(h.prefix);
}

function pageBlockHtml(b: PageBlock, medium: Medium, headingClass: string): string {
  switch (b.t) {
    case 'title':
      return `<p class="booktitle">${esc(b.text)}</p>`;
    case 'subtitle':
      return `<p class="booksubtitle">${esc(b.text)}</p>`;
    case 'author':
      return `<p class="bookauthor">${esc(b.text)}</p>`;
    case 'heading':
      return `<h1 class="${headingClass}">${esc(b.text)}</h1>`;
    case 'line':
      return `<p class="crline">${b.bold ? `<strong>${esc(b.text)}</strong>` : esc(b.text)}</p>`;
    case 'para': {
      const cls = ['crpara', b.align === 'center' ? 'center' : b.align === 'right' ? 'right' : ''].filter(Boolean).join(' ');
      let inner = esc(b.text);
      if (b.bold) inner = `<strong>${inner}</strong>`;
      if (b.italic) inner = `<em>${inner}</em>`;
      return `<p class="${cls}">${inner}</p>`;
    }
    case 'link':
      // ebook: a real hyperlink; print: the address spelled out so it can be typed
      return medium === 'ebook'
        ? `<p class="linkline"><a href="${esc(b.url)}">${esc(b.label)}</a></p>`
        : `<p class="linkline">${esc(b.label)}: ${esc(b.url)}</p>`;
  }
}

export function matterPageHtml(page: MatterPage, medium: Medium): string {
  const cls = page.id === 'title' ? 'titlepage' : page.id === 'copyright' ? 'copyright' : page.id === 'dedication' || page.id === 'epigraph' ? 'centered-page' : 'backpage';
  return `<div class="${cls}">\n${page.blocks
    .map((b) => pageBlockHtml(b, medium, 'matter'))
    .join('\n')}\n</div>`;
}
