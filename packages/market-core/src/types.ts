export interface ParseIssue {
  field: string;
  severity: 'warn' | 'error';
  detail: string;
}

export type ListKind = 'paid' | 'free' | 'bestsellers';

export interface ListEntry {
  rank: number;
  asin: string;
  /** false when the row was lazy-loaded and missing from the saved page; only asin and rank are known. */
  rendered: boolean;
  titleRaw: string | null;
  authorRaw: string | null;
  /** Amazon author-page id; null when the author is shown as plain text. */
  authorId: string | null;
  ratingValue: number | null;
  ratingCount: number | null;
  /** "Kindle Edition", "Audible Audiobook", "Hardcover", ... */
  format: string | null;
  price: number | null;
  /** 'standard' = price in the normal price block; 'offer_from' = "1 offer from $X". */
  priceLayout: 'standard' | 'offer_from' | null;
  /** null when the row has no "N formats available" line (unknown, not zero). */
  formatsAvailable: number | null;
  /** Largest cover URL offered in the row. */
  coverUrl: string | null;
}

export interface CategoryRef {
  name: string;
  nodeId: string | null;
}

export interface ListCapture {
  marketplace: string;
  /** URL store slug, e.g. "digital-text" or "books". */
  storeSlug: string;
  store: 'kindle' | 'books' | 'other';
  nodeId: string;
  categoryName: string;
  /** Ancestors from the department down to (not including) the current category. */
  categoryPath: CategoryRef[];
  listKind: ListKind;
  page: number;
  /** ASINs the page lists (the `data-client-recs-list` JSON). */
  listedCount: number;
  /** Rows actually present in the saved HTML. */
  renderedCount: number;
  entries: ListEntry[];
  issues: ParseIssue[];
}

export interface Person {
  name: string;
  authorId: string | null;
  role: string | null;
}

export interface FormatOffer {
  /** Amazon swatch code: KINDLE, AUDIO_DOWNLOAD, PAPERBACK, HARDCOVER, ... */
  code: string;
  label: string;
  priceText: string | null;
  price: number | null;
  note: string | null;
}

export interface RankEntry {
  store: 'kindle' | 'books' | 'other';
  scope: 'overall' | 'category';
  name: string;
  nodeId: string | null;
  rank: number;
}

export interface ReviewItem {
  stars: number | null;
  title: string | null;
  country: string | null;
  date: string | null;
  verified: boolean;
  format: string | null;
  helpfulVotes: number | null;
  body: string | null;
}

export interface DetailCapture {
  asin: string | null;
  marketplace: string | null;
  canonicalUrl: string | null;
  title: string | null;
  authors: Person[];
  series: { name: string; position: number; total: number | null } | null;
  ratingValue: number | null;
  ratingCount: number | null;
  /** Percentage of ratings per star level, keys "5".."1". */
  histogram: Record<string, number> | null;
  formats: FormatOffer[];
  kindlePrice: number | null;
  pages: number | null;
  publicationDate: string | null;
  publisher: string | null;
  language: string | null;
  isbn13: string | null;
  fileSizeMb: number | null;
  description: string | null;
  coverUrl: string | null;
  ranks: RankEntry[];
  reviews: ReviewItem[];
  relatedAsins: string[];
  sponsoredAsins: string[];
  editorialReviews: string | null;
  aboutAuthor: string | null;
  hasAplus: boolean;
  hasCustomersSay: boolean;
  hasReadSample: boolean;
  /** Every label/value row from the details list, kept verbatim so no field is dropped. */
  detailRows: Record<string, string>;
  issues: ParseIssue[];
}
