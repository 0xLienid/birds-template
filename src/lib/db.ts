import { open, type RootDatabase } from "lmdb";

const instances = new Map<string, RootDatabase>();

export function getDb(path: string): RootDatabase {
  let db = instances.get(path);
  if (db) return db;

  db = open({ path });
  instances.set(path, db);
  return db;
}

export function closeAll(): void {
  for (const db of instances.values()) {
    db.close();
  }
  instances.clear();
}
