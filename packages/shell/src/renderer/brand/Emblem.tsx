import { useId } from 'react';

/** The Cadrel emblem: an angular C holding two pages. Drawn inline so it follows the page's size and needs no file. */
export function Emblem({ size = 28, title }: { size?: number; title?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <defs>
        <linearGradient id={`${id}s`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#344553" /><stop offset="1" stopColor="#142531" /></linearGradient>
        <linearGradient id={`${id}t`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#D1C7B8" /><stop offset="1" stopColor="#A99F90" /></linearGradient>
      </defs>
      <g transform="translate(52 46) scale(1.03)">
        <path fill={`url(#${id}s)`} d="M354 80 282 43Q252 27 224 43L123 101Q86 122 86 165V251Q86 294 123 315L224 373Q252 389 282 373L354 332 313 309Q300 301 287 309L248 331Q230 341 211 330L150 295Q126 281 126 253V163Q126 136 150 122L211 87Q230 76 248 87L287 109Q300 116 313 109Z" />
        <g transform="translate(-27 15)">
          <path fill={`url(#${id}t)`} d="M224 111Q224 105 230 109L267 132Q279 140 279 155V289Q279 296 273 292L229 267Q224 264 224 257Z" />
          <path fill="#B9AF9F" d="M257 98Q257 92 263 96L296 116Q310 124 310 140V270Q310 277 304 273L291 266V157Q291 142 279 135L257 122Z" />
        </g>
      </g>
    </svg>
  );
}
