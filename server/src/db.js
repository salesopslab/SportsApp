import pg from "pg";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

// Line-movement history is optional. If DATABASE_URL isn't set, the rest of
// the app (odds, weather, injuries, chat) keeps working exactly as before —
// it just won't have movement data yet. This lets you deploy this feature
// without breaking anything, then add a free Postgres database whenever
// you're ready.
export const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

let schemaReady = null;

export function ensureSchema() {
  if (!pool) return Promise.resolve();
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS odds_snapshots (
        id BIGSERIAL PRIMARY KEY,
        sport TEXT NOT NULL,
        game_id TEXT NOT NULL,
        book TEXT NOT NULL,
        market TEXT NOT NULL,
        side TEXT,
        point NUMERIC,
        price INTEGER,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_odds_snapshots_lookup
        ON odds_snapshots (game_id, market, side, captured_at);

      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS bets (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sport TEXT NOT NULL,
        game_id TEXT NOT NULL,
        home_team TEXT,
        away_team TEXT,
        market TEXT NOT NULL,          -- 'moneyline' | 'spread' | 'total'
        side TEXT NOT NULL,            -- team name, or 'Over'/'Under'
        point NUMERIC,
        price INTEGER NOT NULL,
        stake NUMERIC NOT NULL DEFAULT 1,
        commence_time TIMESTAMPTZ,
        result TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'win' | 'loss' | 'push'
        settled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_bets_user ON bets (user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_bets_grading ON bets (result, game_id);
    `);
  }
  return schemaReady;
}
