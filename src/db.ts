import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
-- As peças exigidas são dado da campanha.
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  required_pieces_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- signed_off_at é o ato da marca de aprovar a entrega. Se ele está valendo depende das peças.
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns (id),
  signed_off_at TEXT,
  created_at TEXT NOT NULL
);

-- Cada envio de uma peça é uma versão nova. Nenhuma é sobrescrita.
CREATE TABLE IF NOT EXISTS piece_versions (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries (id),
  kind TEXT NOT NULL,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  duration_seconds INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending_review', 'changes_requested', 'approved')),
  review_reason TEXT,
  submitted_at TEXT NOT NULL,
  reviewed_at TEXT,
  UNIQUE (delivery_id, kind, number)
);

-- O comentário pertence a uma versão. Não existe cópia para a versão seguinte.
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES piece_versions (id),
  second INTEGER NOT NULL CHECK (second >= 0),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL REFERENCES deliveries (id),
  event TEXT NOT NULL,
  detail TEXT NOT NULL,
  at TEXT NOT NULL
);
`;

export function openDatabase(path = ":memory:"): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
