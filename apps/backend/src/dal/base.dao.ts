/**
 * Data-access layer, mirroring wallet-platform's DAO pattern
 * (`app/dal/interfaces/base.dao.ts` + `app/dal/models/*.dao.ts`): services never
 * touch the storage engine directly, only a small shared interface. Swapping the
 * in-memory store for a real database means implementing `BaseDao` against that
 * database and changing nothing in `dal/models/*` or any service that consumes it.
 *
 * wallet-platform's `BaseDAO`/`ExtendedBaseDAO` exposes `get()` and
 * `createOrUpdate()`; this adds `list()` and `delete()` since several services
 * here need collection queries the real DAO gets from Mongoose query methods
 * directly.
 */
export interface BaseDao<T> {
  get(id: string): T | undefined;
  list(predicate?: (item: T) => boolean): T[];
  createOrUpdate(item: T): T;
  delete(id: string): boolean;
}

/** Structural shape `InMemoryDao` needs from its backing store - satisfied by
 * both a native `Map<string, T>` (default, wiped on restart) and
 * `store/sqliteMap.ts`'s `SqliteBackedMap<T>` (persists to disk). Whichever one
 * `store/db.ts` constructs is the only thing that decides persistence -
 * nothing here or in any `dal/models/*.dao.ts` file needs to know which. */
export interface KeyedStore<T> {
  get(id: string): T | undefined;
  set(id: string, value: T): unknown;
  delete(id: string): boolean;
  values(): Iterable<T>;
}

export class InMemoryDao<T extends { id: string }> implements BaseDao<T> {
  constructor(private readonly store: KeyedStore<T>) {}

  get(id: string): T | undefined {
    return this.store.get(id);
  }

  list(predicate?: (item: T) => boolean): T[] {
    const all = [...this.store.values()];
    return predicate ? all.filter(predicate) : all;
  }

  createOrUpdate(item: T): T {
    this.store.set(item.id, item);
    return item;
  }

  delete(id: string): boolean {
    return this.store.delete(id);
  }
}
