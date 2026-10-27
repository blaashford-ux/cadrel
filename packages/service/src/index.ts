/**
 * The studio's service: the one place records are read and changed on behalf of a person. Every call names an actor, is checked with the
 * kernel's `can` (the same function the Worker runs), and only then reaches the record code, so no screen, tool or transport can skip the
 * check. In M1 the transport is in-process (the app calls it directly); in M2 the Worker runs the same class behind HTTP.
 *
 * Catalogue records are studio-wide for now, so the permission resource is the studio. Scoped assignments (a role on one project) take part
 * once a book is linked to a project; until then they do not reach catalogue calls, which is the safe way round.
 */
import {
  addEdition, bookByAsin, can, createBook, createIp, createSeries, defaultRole, explain, getBook, listBooks, listIps, listSeries, moveBook, setCatalogueArchived, updateBook, updateEdition,
  type Assignment, type Actor, type Book, type BookWithEditions, type Db, type Decision, type Edition, type Ip, type PermissionContext, type Resource, type Role, type Series
} from '@cadrel/kernel';

export class PermissionDenied extends Error {
  constructor(readonly capability: string, readonly reason: string) {
    super(`You are not allowed to do that (${capability}): ${reason}.`);
  }
}

/** What the service needs to know about who may do what. Read on every call, so a role change takes effect at once. */
export interface Access {
  assignments(): Assignment[] | Promise<Assignment[]>;
  roles(): Role[] | Promise<Role[]>;
  /** The teams the actor is in. */
  teams?(personId: string): string[] | Promise<string[]>;
}

/** The one-person Studio: the person is its Owner. The Studio on this computer, before there is a server, runs on this. */
export function ownerAccess(personId: string, studioId: string): Access {
  const roles = [defaultRole('owner')];
  const assignments: Assignment[] = [{ id: 'owner', subject: { kind: 'person', id: personId }, roleId: roles[0]!.id, scope: { kind: 'studio', id: studioId } }];
  return { assignments: () => assignments, roles: () => roles };
}

export interface ServiceOptions {
  db: Db;
  studioId: string;
  access: Access;
  /** The clock; injected so decisions and stamps are reproducible. */
  now?: () => Date;
}

export class StudioService {
  constructor(private readonly o: ServiceOptions) {}

  /** The service as one person: every call below is checked for and stamped with them. */
  as(personId: string): StudioAs {
    return new StudioAs(this.o, personId);
  }
}

export class StudioAs {
  constructor(private readonly o: ServiceOptions, readonly personId: string) {}

  private async context(): Promise<PermissionContext> {
    const actor: Actor = { personId: this.personId, teamIds: (await this.o.access.teams?.(this.personId)) ?? [] };
    return { actor, assignments: await this.o.access.assignments(), roles: new Map((await this.o.access.roles()).map((r) => [r.id, r])), now: this.stamp() };
  }
  private stamp(): string {
    return (this.o.now?.() ?? new Date()).toISOString();
  }
  private resource(): Resource {
    return { path: [{ kind: 'studio', id: this.o.studioId }] };
  }
  private async need(capability: string): Promise<void> {
    const d = explain(await this.context(), capability, this.resource());
    if (!d.allowed) throw new PermissionDenied(capability, d.reason);
  }
  private ctx() {
    return { studioId: this.o.studioId, actor: this.personId, now: this.stamp() };
  }

  /** Whether this person may do something, and why: the interface greys things out from this and "Explain access" shows the reason. */
  async explain(capability: string): Promise<Decision> {
    return explain(await this.context(), capability, this.resource());
  }
  async can(capability: string): Promise<boolean> {
    return can(await this.context(), capability, this.resource());
  }

  readonly catalogue = {
    ips: async (o?: { archived?: boolean }): Promise<Ip[]> => (await this.need('catalogue.read'), listIps(this.o.db, this.ctx(), o)),
    series: async (o?: { ipId?: string; archived?: boolean }): Promise<Series[]> => (await this.need('catalogue.read'), listSeries(this.o.db, this.ctx(), o)),
    books: async (o?: { seriesId?: string | null; archived?: boolean }): Promise<BookWithEditions[]> => (await this.need('catalogue.read'), listBooks(this.o.db, this.ctx(), o)),
    book: async (id: string): Promise<BookWithEditions | null> => (await this.need('catalogue.read'), getBook(this.o.db, this.ctx(), id)),
    /** The book an ASIN belongs to: how a Market or Finance row finds its record. */
    byAsin: async (asin: string): Promise<{ book: Book; edition: Edition } | null> => (await this.need('catalogue.read'), bookByAsin(this.o.db, this.ctx(), asin)),

    createIp: async (i: Parameters<typeof createIp>[2]): Promise<Ip> => (await this.need('catalogue.create'), createIp(this.o.db, this.ctx(), i)),
    createSeries: async (i: Parameters<typeof createSeries>[2]): Promise<Series> => (await this.need('catalogue.create'), createSeries(this.o.db, this.ctx(), i)),
    createBook: async (i: Parameters<typeof createBook>[2]): Promise<BookWithEditions> => (await this.need('catalogue.create'), createBook(this.o.db, this.ctx(), i)),

    updateBook: async (id: string, patch: Parameters<typeof updateBook>[3]): Promise<BookWithEditions> => (await this.need('catalogue.edit'), updateBook(this.o.db, this.ctx(), id, patch)),
    moveBook: async (id: string, seriesId: string | null, position?: number | null): Promise<BookWithEditions> => (await this.need('catalogue.edit'), moveBook(this.o.db, this.ctx(), id, seriesId, position)),
    addEdition: async (bookId: string, i: Parameters<typeof addEdition>[3]): Promise<Edition> => (await this.need('catalogue.edit'), addEdition(this.o.db, this.ctx(), bookId, i)),
    updateEdition: async (id: string, patch: Parameters<typeof updateEdition>[3]): Promise<Edition> => (await this.need('catalogue.edit'), updateEdition(this.o.db, this.ctx(), id, patch)),

    archive: async (kind: 'ip' | 'series' | 'book' | 'edition', id: string, archived = true): Promise<void> => (await this.need('catalogue.archive'), setCatalogueArchived(this.o.db, this.ctx(), kind, id, archived))
  };
}
