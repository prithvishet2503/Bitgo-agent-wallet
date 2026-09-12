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

export class InMemoryDao<T extends { id: string }> implements BaseDao<T> {
  constructor(private readonly store: Map<string, T>) {}

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
