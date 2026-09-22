import { DatabaseSync } from "node:sqlite";

export function openQaDatabase(): DatabaseSync {
  return new DatabaseSync(".playwright-data/qai.db");
}
