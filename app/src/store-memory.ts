import type { Session, Store } from "./model";

/**
 * In-memory Store. Used by the tests, and by `npm run dev` if IndexedDB is
 * unavailable (private windows on some browsers).
 *
 * `snapshot()` / `restore()` exist so a test can simulate an app restart: same
 * data on disk, brand new service instance, nothing cached in closures.
 */
export class MemoryStore implements Store {
  private sessions = new Map<string, Session>();
  private meta = new Map<string, unknown>();

  async getSession(id: string) {
    return this.sessions.get(id);
  }

  async putSession(s: Session) {
    this.sessions.set(s.id, structuredClone(s));
  }

  async deleteSession(id: string) {
    this.sessions.delete(id);
  }

  async listSessions() {
    return [...this.sessions.values()]
      .map((s) => structuredClone(s))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async getMeta<T>(key: string) {
    return this.meta.get(key) as T | undefined;
  }

  async setMeta(key: string, value: unknown) {
    this.meta.set(key, value);
  }

  snapshot(): string {
    return JSON.stringify({
      sessions: [...this.sessions.values()],
      meta: [...this.meta.entries()],
    });
  }

  static restore(json: string): MemoryStore {
    const parsed = JSON.parse(json) as {
      sessions: Session[];
      meta: [string, unknown][];
    };
    const store = new MemoryStore();
    for (const s of parsed.sessions) store.sessions.set(s.id, s);
    for (const [k, v] of parsed.meta) store.meta.set(k, v);
    return store;
  }
}
