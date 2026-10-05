/**
 * Minimal synchronous SQL adapter. Everything in the api talks to this interface, never to the
 * driver directly, so better-sqlite3 can be swapped (e.g. for node:sqlite) in one place.
 */
export type SqlParam = string | number | bigint | null | Uint8Array;

export interface SqlRunResult {
  changes: number;
}

export interface SqlStatement {
  run(...params: SqlParam[]): SqlRunResult;
  get(...params: SqlParam[]): unknown;
  all(...params: SqlParam[]): unknown[];
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  /** Run fn inside a transaction (BEGIN/COMMIT, ROLLBACK on throw). */
  transaction<T>(fn: () => T): T;
  close(): void;
}
