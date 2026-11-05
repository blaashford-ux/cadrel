import type { ScopeView } from '../shared/api';

const api = window.cadrel.scope;

/**
 * The rail's scope button: the Project (and Book) the app is showing. It opens a native menu to change them, which draws above the module
 * views (Write, Market, Finance), something a list in this page could not do. With no Project there is nothing to scope, so it is absent.
 */
export function ScopeButton({ scope }: { scope: ScopeView | null }) {
  if (!scope?.project || !scope.projectName) return null;
  const project = scope.projectName;
  const book = scope.bookName ?? (scope.books.length > 1 ? 'All books' : null);
  const label = book ? `${project}, ${book}` : project;
  return (
    <button
      type="button"
      className="scope-btn"
      aria-label={`Project: ${label}. Change`}
      aria-haspopup="menu"
      title={`${label}\nChoose the project and book Cadrel is showing`}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        void api.openMenu({ x: Math.round(r.right), y: Math.round(r.top) });
      }}
    >
      <span className="scope-project">{project}</span>
      {book && <span className="scope-book">{book}</span>}
    </button>
  );
}
