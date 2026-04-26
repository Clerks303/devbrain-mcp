import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { KnowledgeStore } from '../db/store.js';
import { VectorStore } from '../db/vector.js';

/**
 * Direct SQLite access for the daemon.
 * Opens its own connection with WAL-friendly pragmas.
 * Safe for concurrent reads with the MCP server.
 */
export class DirectDbWriter {
  readonly store: KnowledgeStore;
  readonly vectorStore: VectorStore;
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    sqliteVec.load(this.db);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -2000'); // 2 MB page cache
    this.db.pragma('foreign_keys = ON');
    this.store = new KnowledgeStore(this.db);
    this.vectorStore = new VectorStore(this.db);
  }

  /** Run operations in a transaction for batch writes */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}
