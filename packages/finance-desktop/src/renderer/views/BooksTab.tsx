import { useEffect, useState } from 'react';
import { DataTable, type Column } from '@cadrel/market-desktop/src/renderer/views/DataTable.js';
import type { OwnBookRow } from './types.js';
import { KdpReportImport } from './KdpReportImport.js';

const api = window.cadrelFinance;
const n = (v: number | null) => (v === null ? '' : v.toLocaleString('en-US'));

/**
 * The studio's books as the KDP reports know them. Importing the Orders / KENP Read / Payments reports is how money gets in; a book in
 * a report is added to the studio's own books (Market's list) even before a page of it has been captured. Which books are "own" is
 * Market's record: it is read here and changed there.
 */
export function BooksTab({ version, onImported }: { version: number; onImported: () => void }) {
  const [books, setBooks] = useState<OwnBookRow[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => { void api.ownBooks().then(setBooks, (e) => setErr(String(e.message ?? e))); }, [version]);

  const penNames = [...new Set((books ?? []).flatMap((b) => b.penNames))].sort((x, y) => x.localeCompare(y));
  const columns: Column<OwnBookRow>[] = [
    { key: 'title', label: 'Title', get: (b) => b.title ?? b.asin, title: (b) => b.asin },
    { key: 'author', label: 'Author', get: (b) => b.authorNames.join(', ') },
    { key: 'penName', label: 'Pen Name', choices: [...penNames, ''], get: (b) => b.penNames.join(', '), values: (b) => (b.penNames.length ? b.penNames : ['']), title: () => 'The author names KDP reports the book under (all of them for a collaboration). Editors, illustrators and other roles are not included' },
    { key: 'orders', label: 'Orders', num: true, get: (b) => b.paidUnits, render: (b) => n(b.paidUnits), title: (b) => (b.lastSaleDay ? `Paid units in the Orders reports you imported; last sale ${b.lastSaleDay}` : 'Paid units in the Orders reports you imported') },
    { key: 'ku', label: 'KU pages read', num: true, get: (b) => b.kenpPages, render: (b) => n(b.kenpPages), title: () => 'Kindle Unlimited pages read in the KENP Read reports you imported' }
  ];

  return (
    <>
      <p className="muted">
        Import the report workbooks from KDP Reports (kdpreports.amazon.com): the Orders download with its royalty sheets, the KENP Read download and the Payments report. Days that overlap an earlier import are replaced. The figures feed the charts, the Month view, the royalty splits and the author statements on the other tabs.
      </p>
      <div className="row"><KdpReportImport onImported={onImported} /></div>
      {err && <div className="err" role="alert">{err}</div>}
      {books === null ? null : books.length === 0 ? (
        <p className="muted">No books yet. Import a KDP report above and its books appear here.</p>
      ) : (
        <DataTable rows={books} columns={columns} rowKey={(b) => b.asin} rowProps={(b) => ({ 'data-asin': b.asin })} noun="book" />
      )}
    </>
  );
}
