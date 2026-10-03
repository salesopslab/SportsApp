// AI Pick Packs: pick credits sold in one-time packs, plus one free pick per
// new account. One credit unlocks one locked pick from the public picks
// ledger (the same picks Hot Picks buyers see early), permanently for that
// user. Sits alongside the subscription plans; it doesn't change them.
//
// Funnel: Free Pick -> Pick Pack -> monthly Edge membership.
import { pool, ensureSchema } from "../db.js";
import { isRevealed, viewFor } from "./picksService.js";
import { normalizeEmailForAbuseCheck } from "./referralService.js";

// Server-side source of truth for what each pack costs and grants. The
// client only ever sends a pack id.
export const PICK_PACKS = [
  { id: "pack_3", credits: 3, priceCents: 1999, name: "3 AI Picks", cta: "GET 3 PICKS", badge: null },
  { id: "pack_5", credits: 5, priceCents: 2999, name: "5 AI Picks", cta: "GET 5 PICKS", badge: "MOST POPULAR" },
  { id: "pack_10", credits: 10, priceCents: 4999, name: "10 AI Pick Credits", cta: "GET 10 PICKS", badge: "BEST VALUE" },
];
export const FREE_PICK = { id: "free_1", credits: 1, priceCents: 0, name: "1 Free AI Pick" };

export function packById(id) {
  return PICK_PACKS.find((p) => p.id === id) || null;
}

// Public shape for the pricing cards (per-pick price computed, not typed in).
export function publicPacks() {
  return PICK_PACKS.map((p) => ({
    ...p,
    // Rounded up to the cent, so it never understates the price ($19.99 / 3 = $6.67).
    perPickCents: Math.ceil(p.priceCents / p.credits),
  }));
}

// When to show the soft "Unlock the Full Edge" membership nudge: someone
// without a live subscription who has bought a pack or used 2+ credits.
// The client decides how often (it's dismissible and throttled there).
export const UPGRADE_NUDGE = { minPacks: 1, minUnlocks: 2 };

function hasLiveSubscription(row) {
  return !!row.stripe_subscription_id && ["active", "trialing"].includes(row.subscription_status);
}

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Everything the Pick Packs screen and account window need for one user.
export async function creditSummary(userId) {
  await ensureSchema();
  const { rows } = await pool.query(
    "SELECT id, pick_credits, free_pick_claimed_at, stripe_subscription_id, subscription_status FROM users WHERE id = $1",
    [userId]
  );
  if (!rows.length) return null;
  const u = rows[0];
  const [{ rows: purchases }, { rows: unlockRows }] = await Promise.all([
    pool.query(
      "SELECT id, pack_id, credits, amount_cents, currency, purchased_at FROM pick_pack_purchases WHERE user_id = $1 ORDER BY purchased_at DESC LIMIT 50",
      [userId]
    ),
    pool.query("SELECT COUNT(*)::int AS n FROM pick_unlocks WHERE user_id = $1", [userId]),
  ]);
  const unlocks = unlockRows[0].n;
  const claimed = !!u.free_pick_claimed_at;
  const subscribed = hasLiveSubscription(u);
  return {
    credits: u.pick_credits,
    unlockedCount: unlocks,
    freePick: {
      claimed,
      claimedAt: u.free_pick_claimed_at,
      eligible: !claimed,
      // "Used" = they've claimed it and unlocked at least one pick since.
      used: claimed && unlocks > 0,
    },
    subscribed,
    showUpgrade: !subscribed && (purchases.length >= UPGRADE_NUDGE.minPacks || unlocks >= UPGRADE_NUDGE.minUnlocks),
    purchases: purchases.map((p) => ({
      id: Number(p.id),
      packId: p.pack_id,
      name: packById(p.pack_id)?.name || `${p.credits} AI Picks`,
      credits: p.credits,
      amountCents: p.amount_cents,
      currency: p.currency,
      purchasedAt: p.purchased_at,
    })),
  };
}

// One free pick per account (and per inbox: +tags and Gmail dots collapse
// to the same key). Atomic: the conditional UPDATE and the unique index on
// free_pick_key mean two simultaneous claims can only succeed once.
// Returns { ok, credits } or { ok:false, error, code }.
export async function claimFreePick(userId) {
  await ensureSchema();
  try {
    return await withTx(async (c) => {
      const { rows } = await c.query("SELECT email, free_pick_claimed_at FROM users WHERE id = $1 FOR UPDATE", [userId]);
      if (!rows.length) return { ok: false, code: 404, error: "User not found." };
      if (rows[0].free_pick_claimed_at) return { ok: false, code: 409, error: "You've already claimed your free AI pick." };
      const key = normalizeEmailForAbuseCheck(rows[0].email);
      const upd = await c.query(
        `UPDATE users SET free_pick_claimed_at = now(), free_pick_key = $2, pick_credits = pick_credits + $3
          WHERE id = $1 AND free_pick_claimed_at IS NULL RETURNING pick_credits`,
        [userId, key, FREE_PICK.credits]
      );
      const balance = upd.rows[0].pick_credits;
      await c.query(
        "INSERT INTO pick_credit_transactions (user_id, delta, reason, balance_after) VALUES ($1, $2, 'free_pick', $3)",
        [userId, FREE_PICK.credits, balance]
      );
      return { ok: true, credits: balance };
    });
  } catch (err) {
    if (err.code === "23505") return { ok: false, code: 409, error: "A free AI pick has already been claimed for this email address." };
    throw err;
  }
}

// Grants a paid pack's credits for a Stripe Checkout session — called from
// the webhook AND from the success-page confirm, whichever lands first.
// Safe to call any number of times for the same session: the UNIQUE
// session id on pick_pack_purchases means credits are added exactly once.
// The session must come from Stripe (signed webhook or a server-side
// retrieve), never from the client.
// Returns { status: 'granted' | 'duplicate' | 'ignored', reason?, credits?, userId? }.
export async function fulfillPickPackSession(session) {
  if (!session || session.mode !== "payment" || session.metadata?.kind !== "pick_pack") {
    return { status: "ignored", reason: "not a pick pack session" };
  }
  if (session.payment_status !== "paid") {
    return { status: "ignored", reason: `payment not completed (${session.payment_status || "unknown"})` };
  }
  const userId = Number(session.metadata?.betedgeUserId);
  const pack = packById(session.metadata?.packId);
  // Credits were written into metadata by our own server at checkout time,
  // so a later price/pack change can never short a customer who already paid.
  const credits = Number(session.metadata?.credits) || pack?.credits;
  if (!Number.isInteger(userId) || userId <= 0 || !pack || !Number.isInteger(credits) || credits <= 0 || credits > 100) {
    console.error(`Pick pack session ${session.id} has bad metadata:`, session.metadata);
    return { status: "ignored", reason: "bad metadata" };
  }
  await ensureSchema();
  return withTx(async (c) => {
    const ins = await c.query(
      `INSERT INTO pick_pack_purchases (user_id, pack_id, credits, amount_cents, currency, stripe_checkout_session_id, stripe_payment_intent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (stripe_checkout_session_id) DO NOTHING
       RETURNING id`,
      [userId, pack.id, credits, session.amount_total ?? pack.priceCents, session.currency || "usd", session.id,
        typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || null]
    );
    if (!ins.rows.length) {
      const { rows } = await c.query("SELECT pick_credits FROM users WHERE id = $1", [userId]);
      return { status: "duplicate", userId, credits: rows[0]?.pick_credits ?? null };
    }
    const upd = await c.query("UPDATE users SET pick_credits = pick_credits + $2 WHERE id = $1 RETURNING pick_credits", [userId, credits]);
    if (!upd.rows.length) throw new Error(`Pick pack session ${session.id}: user ${userId} not found`);
    const balance = upd.rows[0].pick_credits;
    await c.query(
      "INSERT INTO pick_credit_transactions (user_id, delta, reason, pick_pack_purchase_id, balance_after) VALUES ($1, $2, 'purchase', $3, $4)",
      [userId, credits, ins.rows[0].id, balance]
    );
    return { status: "granted", userId, added: credits, credits: balance };
  });
}

// Pick ids this user has unlocked with a credit.
export async function unlockedPickIds(userId) {
  if (!pool || !userId) return new Set();
  await ensureSchema();
  const { rows } = await pool.query("SELECT pick_id FROM pick_unlocks WHERE user_id = $1", [userId]);
  return new Set(rows.map((r) => Number(r.pick_id)));
}

// Spend one credit to unlock one pick. Never charges twice for the same pick,
// never charges for a pick that's already public (game started / graded) or
// for a Hot Picks buyer who can already see it. The user row is locked for
// the whole transaction, so a double-tap can't spend two credits.
// Returns { status: 'unlocked' | 'already_unlocked' | 'public' | 'entitled' | 'no_credits' | 'not_found', pick?, credits }.
export async function unlockPick(userId, pickId, { entitled = false } = {}) {
  await ensureSchema();
  const id = Number(pickId);
  if (!Number.isInteger(id) || id <= 0) return { status: "not_found" };
  return withTx(async (c) => {
    const { rows: picks } = await c.query("SELECT * FROM picks WHERE id = $1", [id]);
    const { rows: users } = await c.query("SELECT pick_credits FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (!users.length) return { status: "not_found" };
    let credits = users[0].pick_credits;
    if (!picks.length) return { status: "not_found", credits };
    const row = picks[0];
    const full = () => viewFor(row, { entitled: true });
    if (isRevealed(row)) return { status: "public", pick: viewFor(row), credits };
    const { rows: had } = await c.query("SELECT 1 FROM pick_unlocks WHERE user_id = $1 AND pick_id = $2", [userId, id]);
    if (had.length) return { status: "already_unlocked", pick: { ...full(), unlocked: true }, credits };
    if (entitled) return { status: "entitled", pick: full(), credits };
    if (credits < 1) return { status: "no_credits", credits };
    await c.query("INSERT INTO pick_unlocks (user_id, pick_id) VALUES ($1, $2)", [userId, id]);
    const upd = await c.query("UPDATE users SET pick_credits = pick_credits - 1 WHERE id = $1 RETURNING pick_credits", [userId]);
    credits = upd.rows[0].pick_credits;
    await c.query(
      "INSERT INTO pick_credit_transactions (user_id, delta, reason, pick_id, balance_after) VALUES ($1, -1, 'unlock', $2, $3)",
      [userId, id, credits]
    );
    return { status: "unlocked", pick: { ...full(), unlocked: true }, credits };
  });
}
