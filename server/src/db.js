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

      -- Referral program: every user gets their own shareable code; signing
      -- up with someone else's code links the two accounts so that, once the
      -- referee actually subscribes, both sides can be granted bonus access.
      -- bonus_access_until works exactly like trial_ends_at (effectiveTier
      -- treats a live one as Edge Pro-level access) but stacks on top of
      -- whatever tier/subscription the account already has.
      ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_user_id BIGINT REFERENCES users(id);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_access_until TIMESTAMPTZ;
      -- Captured at signup for referral self-abuse checks (see referralService.js
      -- isSelfReferral) — not used for anything else, and never shown to users.
      ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_ip TEXT;
      CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users (referral_code);

      -- Bankroll tracking is an Edge-tier bet-tracker feature: the user sets
      -- a starting bankroll once, and current bankroll (starting + net P/L)
      -- is derived from it rather than stored, so it always stays correct
      -- as bets settle. Nullable -- bankroll tracking is opt-in.
      ALTER TABLE users ADD COLUMN IF NOT EXISTS starting_bankroll NUMERIC;

      -- One row per referee whose reward was blocked as a likely self-referral
      -- (same normalized email or same signup IP as the referrer), so it's
      -- visible/auditable rather than just silently skipped.
      CREATE TABLE IF NOT EXISTS referral_rewards_blocked (
        id BIGSERIAL PRIMARY KEY,
        referrer_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        referee_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reason TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- One row per referee who has triggered a reward, so a webhook retry
      -- (or a plan change that fires checkout.session.completed again) can
      -- never grant the bonus twice for the same referral.
      CREATE TABLE IF NOT EXISTS referral_rewards (
        id BIGSERIAL PRIMARY KEY,
        referrer_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        referee_user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        bonus_days INTEGER NOT NULL,
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

      -- "My Picks" -> full personal bet tracker/ledger. BetEdge AI never
      -- accepts or holds a wager itself — these columns just let a user
      -- record a real-dollar bet they placed elsewhere (or a BetEdge pick
      -- with a dollar amount attached) instead of the original units-only
      -- tracking. wager_amount is nullable on purpose: an existing/legacy
      -- pick with no dollar amount keeps working as a units-only pick
      -- (stake column, as before) rather than being forced to carry a $0
      -- wager, and a user can attach a real wager to it later.
      ALTER TABLE bets ADD COLUMN IF NOT EXISTS wager_amount NUMERIC;
      ALTER TABLE bets ADD COLUMN IF NOT EXISTS cash_out_amount NUMERIC;
      ALTER TABLE bets ADD COLUMN IF NOT EXISTS bet_source TEXT NOT NULL DEFAULT 'betedge_pick'; -- 'betedge_pick' | 'custom'
      -- Freeform overrides used by custom (off-platform) bets, whose
      -- game/market/line don't fit our own structured odds data — left null
      -- for ordinary BetEdge picks, which keep using home_team/away_team/
      -- market/side/point exactly as before.
      ALTER TABLE bets ADD COLUMN IF NOT EXISTS event_label TEXT;
      ALTER TABLE bets ADD COLUMN IF NOT EXISTS bet_type_label TEXT;
      ALTER TABLE bets ADD COLUMN IF NOT EXISTS line_label TEXT;
      ALTER TABLE bets ADD COLUMN IF NOT EXISTS bet_date DATE;

      -- Parlays/teasers: the parent bets row still holds the combined
      -- odds, wager, and overall result (market = 'parlay' | 'teaser'), same
      -- as any other bet — everything that already reads bets (record,
      -- ROI, performance breakdowns) keeps working unchanged. Each leg lives
      -- in its own row here so it can carry its own game/line/odds and be
      -- settled independently; the parent's result is then rolled up from
      -- its legs (any leg loss -> parent loss immediately, matching how a
      -- real parlay works) rather than stored redundantly.
      ALTER TABLE bets ADD COLUMN IF NOT EXISTS teaser_points NUMERIC; -- teaser point adjustment (e.g. 6, 6.5, 7); null for everything else
      CREATE TABLE IF NOT EXISTS bet_legs (
        id BIGSERIAL PRIMARY KEY,
        bet_id BIGINT NOT NULL REFERENCES bets(id) ON DELETE CASCADE,
        leg_order INTEGER NOT NULL DEFAULT 0,
        sport TEXT,
        game_id TEXT,
        home_team TEXT,
        away_team TEXT,
        market TEXT,              -- 'moneyline' | 'spread' | 'total' | 'prop' | 'custom'
        side TEXT,
        point NUMERIC,
        original_point NUMERIC,   -- teaser only: the line before the adjustment
        price INTEGER,            -- this leg's own odds, if the user had them
        label TEXT,               -- freeform display text (e.g. a prop description) when structured fields don't cover it
        result TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'win' | 'loss' | 'push'
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_bet_legs_bet ON bet_legs (bet_id, leg_order);

      -- One row per Ledger AI screenshot scan actually sent to the model
      -- (POST /api/bets/scan) -- lets the route enforce a per-tier monthly
      -- cap (Edge gets a handful, Edge Pro gets substantially more) without
      -- guessing usage from anything else. A row is written only for a scan
      -- that actually reached the model, not a request rejected for a bad
      -- image or for being over the cap.
      CREATE TABLE IF NOT EXISTS bet_scan_usage (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_bet_scan_usage_user_time ON bet_scan_usage (user_id, created_at);

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
