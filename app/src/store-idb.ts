import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Session, Store } from "./model";

interface LiftLabDB extends DBSchema {
  sessions: { key: string; value: Session; indexes: { startedAt: string } };
  meta: { key: string; value: unknown };
}

const DB_NAME = "liftlab";
const DB_VERSION = 1;

async function open(): Promise<IDBPDatabase<LiftLabDB>> {
  return openDB<LiftLabDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("sessions")) {
        const s = db.createObjectStore("sessions", { keyPath: "id" });
        s.createIndex("startedAt", "startedAt");
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta");
      }
    },
  });
}

/** IndexedDB implementation of the same Store interface the tests use. */
export class IdbStore implements Store {
  private dbp = open();

  async getSession(id: string) {
    return (await this.dbp).get("sessions", id);
  }

  async putSession(s: Session) {
    await (await this.dbp).put("sessions", s);
  }

  async deleteSession(id: string) {
    await (await this.dbp).delete("sessions", id);
  }

  async listSessions() {
    const all = await (await this.dbp).getAllFromIndex("sessions", "startedAt");
    return all.reverse(); // index is ascending; we want newest first
  }

  async getMeta<T>(key: string) {
    return (await (await this.dbp).get("meta", key)) as T | undefined;
  }

  async setMeta(key: string, value: unknown) {
    await (await this.dbp).put("meta", value, key);
  }

  /** Everything, for the export path. */
  async exportAll(): Promise<Session[]> {
    return this.listSessions();
  }

  /** Import previously exported sessions. Existing ids are left untouched. */
  async importSessions(sessions: Session[]): Promise<number> {
    const db = await this.dbp;
    const tx = db.transaction("sessions", "readwrite");
    let added = 0;
    for (const s of sessions) {
      if (!(await tx.store.get(s.id))) {
        await tx.store.put(s);
        added += 1;
      }
    }
    await tx.done;
    return added;
  }
}
