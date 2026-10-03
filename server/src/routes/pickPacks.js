import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { withTier } from "../middleware/tier.js";
import { hasPickAccess } from "../services/ledgerService.js";
import { stripeAvailable, getOrCreateCustomer, createPickPackCheckoutSession, retrieveCheckoutSession } from "../services/stripeService.js";
import { publicPacks, packById, FREE_PICK, creditSummary, claimFreePick, fulfillPickPackSession, unlockPick } from "../services/pickPackService.js";

// AI Pick Packs — one-time credit packs, the free first pick, and spending
// a credit to unlock a pick. Payment fulfillment itself lives in
// pickPackService.fulfillPickPackSession, shared with the Stripe webhook.
const router = Router();

function needDb(res) {
  if (pool) return false;
  res.status(503).json({ error: "Pick Packs need a database." });
  return true;
}

// Appends ?pickpack=success&session_id={CHECKOUT_SESSION_ID} (Stripe fills
// the placeholder in) so the app can confirm the payment on return.
function successUrlFor(base) {
  const url = String(base || "https://www.betedgeai.com/").split("#")[0];
  return `${url}${url.includes("?") ? "&" : "?"}pickpack=success&session_id={CHECKOUT_SESSION_ID}`;
}

// GET /api/pick-packs — public pack list; if logged in, also the user's
// balance, free-pick state, purchase history and whether to show the
// membership nudge.
router.get("/", withTier, async (req, res) => {
  const base = { packs: publicPacks(), freePick: FREE_PICK, available: stripeAvailable() && !!pool, loggedIn: !!req.userRow };
  if (!req.userRow || !pool) return res.json(base);
  try {
    res.json({ ...base, account: await creditSummary(req.userRow.id) });
  } catch (err) {
    console.error("pick packs summary:", err);
    res.status(500).json({ error: "Couldn't load your pick credits." });
  }
});

// POST /api/pick-packs/claim-free — the one free pick for a new account.
// No card: it just adds 1 credit (once per account and per inbox).
router.post("/claim-free", requireAuth, async (req, res) => {
  if (needDb(res)) return;
  try {
    const r = await claimFreePick(req.user.id);
    if (!r.ok) return res.status(r.code || 400).json({ error: r.error, account: await creditSummary(req.user.id) });
    res.json({ claimed: true, credits: r.credits, account: await creditSummary(req.user.id) });
  } catch (err) {
    console.error("claim free pick:", err);
    res.status(500).json({ error: "Couldn't claim your free pick." });
  }
});

// POST /api/pick-packs/checkout { packId, successUrl, cancelUrl } — Stripe
// Checkout (one-time payment) for a pack. Credits are only added once Stripe
// confirms the payment (webhook or /confirm below), never here.
router.post("/checkout", requireAuth, async (req, res) => {
  if (needDb(res)) return;
  try {
    if (!stripeAvailable()) return res.status(503).json({ error: "Billing isn't configured yet." });
    const pack = packById(req.body?.packId);
    if (!pack) return res.status(400).json({ error: "Unknown pick pack." });
    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "User not found." });
    const userRow = rows[0];
    // Same Stripe customer as subscriptions, so a pack buyer who later
    // subscribes keeps one billing history.
    const customerId = await getOrCreateCustomer(userRow);
    if (!userRow.stripe_customer_id) {
      await pool.query("UPDATE users SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id IS NULL", [customerId, userRow.id]);
    }
    const session = await createPickPackCheckoutSession({
      customerId,
      userId: userRow.id,
      pack,
      successUrl: successUrlFor(req.body?.successUrl),
      cancelUrl: req.body?.cancelUrl || "https://www.betedgeai.com/",
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("pick pack checkout:", err);
    res.status(500).json({ error: "Failed to start checkout.", detail: err.message });
  }
});

// POST /api/pick-packs/confirm { sessionId } — called by the app on return
// from Checkout so the balance updates immediately. Re-reads the session
// from Stripe (never trusts the client), checks it's this user's and paid,
// then fulfills idempotently — a no-op if the webhook already did it.
router.post("/confirm", requireAuth, async (req, res) => {
  if (needDb(res)) return;
  try {
    if (!stripeAvailable()) return res.status(503).json({ error: "Billing isn't configured yet." });
    const sessionId = String(req.body?.sessionId || "");
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return res.status(400).json({ error: "Missing checkout session." });
    const session = await retrieveCheckoutSession(sessionId);
    if (!session || String(session.metadata?.betedgeUserId) !== String(req.user.id)) {
      return res.status(404).json({ error: "That purchase isn't on this account." });
    }
    const r = await fulfillPickPackSession(session);
    const account = await creditSummary(req.user.id);
    if (r.status === "ignored") return res.status(202).json({ confirmed: false, pending: session.payment_status !== "paid", reason: r.reason, account });
    res.json({ confirmed: true, added: r.status === "granted" ? r.added : 0, account });
  } catch (err) {
    console.error("pick pack confirm:", err);
    res.status(500).json({ error: "Couldn't confirm your purchase yet.", detail: err.message });
  }
});

// POST /api/pick-packs/unlock { pickId } — spend 1 credit on a locked pick.
// 402 with needCredits when the balance is 0, so the app opens Pick Packs.
router.post("/unlock", requireAuth, async (req, res) => {
  if (needDb(res)) return;
  try {
    const entitled = await hasPickAccess(req.user.id);
    const r = await unlockPick(req.user.id, req.body?.pickId, { entitled });
    if (r.status === "not_found") return res.status(404).json({ error: "That pick wasn't found.", credits: r.credits ?? null });
    if (r.status === "no_credits") return res.status(402).json({ error: "You're out of AI pick credits.", needCredits: true, credits: 0 });
    res.json({ status: r.status, charged: r.status === "unlocked", pick: r.pick, credits: r.credits });
  } catch (err) {
    console.error("pick unlock:", err);
    res.status(500).json({ error: "Couldn't unlock that pick." });
  }
});

export default router;
