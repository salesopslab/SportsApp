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
      -- Subscription/tier fields, added via ALTER so this also upgrades
      -- existing rows on an already-deployed database, not just fresh ones.
      -- tier: 'trial' | 'standard' | 'edge' | 'edge_pro' | 'expired'
      --   'trial' gets full (Edge Pro-level) access for trial_ends_at's window.
      --   'expired' means a trial that ran out, or a subscription that lapsed
      --   (canceled/unpaid) — falls back to the free Board-only experience.
      ALTER TABLE users ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'trial';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT;
      CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users (stripe_customer_id);

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

      CREATE TABLE IF NOT EXISTS odds_api_usage (
        id BIGSERIAL PRIMARY KEY,
        requests_used INTEGER,
        requests_remaining INTEGER,
        requests_last INTEGER,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_odds_api_usage_time ON odds_api_usage (recorded_at DESC);
    `);
  }
  return schemaReady;
}
