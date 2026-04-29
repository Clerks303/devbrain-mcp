// Cursor-based (keyset) pagination for list endpoints.
//
// Why both cursor and offset? Offset/limit is fine up to ~10k rows but
// degrades on large tables (SQLite re-scans skipped rows). Cursors stay O(log n)
// because they translate into an indexed range scan on (sort_key, id).
//
// Cursor encodes (timestamp, id) — the ORDER BY key plus a stable tiebreaker.
// Both ends are base64-JSON, so the cursor is opaque to clients.

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CursorParts {
  ts: string; // ISO timestamp from updated_at / created_at column
  id: string; // tiebreaker for rows sharing the same ts
}

export function encodeCursor(parts: CursorParts): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorParts | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const obj = JSON.parse(raw) as CursorParts;
    if (typeof obj?.ts !== 'string' || typeof obj?.id !== 'string') return null;
    return obj;
  } catch {
    return null;
  }
}
