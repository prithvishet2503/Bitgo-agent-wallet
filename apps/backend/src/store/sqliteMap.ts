import Database from 'better-sqlite3';

/**
 * A `Map<string, T>`-compatible store backed by SQLite instead of memory, so
 * `InMemoryDao` (dal/base.dao.ts) can be reused completely unchanged - every
 * `dal/models/*.dao.ts` file and every service built on top of it stays
 * identical. This is the whole point of the DAO layer: swapping the storage
 * engine (db.ts) is the only thing that changes.
 *
 * Rows are stored as one JSON blob per id rather than typed columns - a
 * document-store-over-SQL shape appropriate for a prototype with a dozen
 * evolving entity shapes and no need for SQL-level querying (every query in
 * this codebase already filters in JS via DAO predicates).
 */
export class SqliteBackedMap<T> {
  private readonly db: Database.Database;
  private readonly table: string;

  constructor(db: Database.Database, table: string) {
    this.db = db;
    // `table` is always one of a fixed set of internal identifiers (see
    // store/db.ts), never user input, so string interpolation into DDL/DML
    // here is safe.
    this.table = table;
    this.db.exec(`CREATE TABLE IF NOT EXISTS "${this.table}" (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  }

  get(id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM "${this.table}" WHERE id = ?`).get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  set(id: string, value: T): this {
    this.db
      .prepare(`INSERT INTO "${this.table}" (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`)
      .run(id, JSON.stringify(value));
    return this;
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  delete(id: string): boolean {
    const info = this.db.prepare(`DELETE FROM "${this.table}" WHERE id = ?`).run(id);
    return info.changes > 0;
  }

  clear(): void {
    this.db.exec(`DELETE FROM "${this.table}"`);
  }

  values(): T[] {
    const rows = this.db.prepare(`SELECT data FROM "${this.table}"`).all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as T);
  }

  get size(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM "${this.table}"`).get() as { count: number };
    return row.count;
  }
}

/**
 * Append-only variant for the audit log / gas-sponsorship ledger, which the
 * services that own them treat as plain arrays (`push`, iterate, filter)
 * rather than id-keyed entities.
 */
export class SqliteBackedList<T extends { id: string }> {
  private readonly db: Database.Database;
  private readonly table: string;

  constructor(db: Database.Database, table: string) {
    this.db = db;
    this.table = table;
    this.db.exec(`CREATE TABLE IF NOT EXISTS "${this.table}" (id TEXT PRIMARY KEY, data TEXT NOT NULL, seq INTEGER)`);
  }

  push(value: T): void {
    const seqRow = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 as next FROM "${this.table}"`).get() as { next: number };
    this.db
      .prepare(`INSERT INTO "${this.table}" (id, data, seq) VALUES (?, ?, ?)`)
      .run(value.id, JSON.stringify(value), seqRow.next);
  }

  all(): T[] {
    const rows = this.db.prepare(`SELECT data FROM "${this.table}" ORDER BY seq ASC`).all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as T);
  }

  clear(): void {
    this.db.exec(`DELETE FROM "${this.table}"`);
  }
}

let sharedDb: Database.Database | undefined;

/** One shared SQLite connection for the whole process, file-based so data
 * survives a restart (the PRD's own gap this closes: "restarting the backend
 * forgets which addresses it deployed"). */
export function getSqliteConnection(filePath: string): Database.Database {
  if (!sharedDb) {
    sharedDb = new Database(filePath);
    sharedDb.pragma('journal_mode = WAL');
  }
  return sharedDb;
}
