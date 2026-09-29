// Billing integration test: real auth / billing / admin / chat / fantasy
// routes and a real Postgres database, with Stripe and Anthropic faked.
// Needs a scratch database: TEST_DATABASE_URL=postgres://... node test/billing.test.mjs
// (skipped when TEST_DATABASE_URL isn't set, so `npm test` still runs anywhere).
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";

if (!process.env.TEST_DATABASE_URL) {
  console.log("SKIP  billing tests (set TEST_DATABASE_URL to a scratch Postgres database to run them)");
  process.exit(0);
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DATABASE_SSL = "false";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
process.env.ADMIN_KEY = "admin-test";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.WEB_SEARCH_ENABLED = "false";
process.env.JWT_SECRET = "test-secret";
// Legacy prices (what live subscribers are on today).
process.env.STRIPE_PRICE_STANDARD = "price_legacy_std";
process.env.STRIPE_PRICE_EDGE = "price_legacy_edge";
process.env.STRIPE_PRICE_EDGE_PRO = "price_legacy_pro";

// ---- Fake Stripe ------------------------------------------------------------
let seq = 0;
const id = (p) => `${p}_${++seq}`;
const S = { prices: [], products: [], customers: [], sessions: [], subs: new Map(), updates: [] };
function seedLegacy() {
  S.products.push({ id: "prod_std", name: "Standard" }, { id: "prod_edge", name: "Edge" }, { id: "prod_pro", name: "Edge Pro" });
  S.prices.push(
    { id: "price_legacy_std", product: "prod_std", unit_amount: 1999, active: true, recurring: { interval: "month" }, lookup_key: null, metadata: {} },
    { id: "price_legacy_edge", product: "prod_edge", unit_amount: 2999, active: true, recurring: { interval: "month" }, lookup_key: null, metadata: {} },
    { id: "price_legacy_pro", product: "prod_pro", unit_amount: 4999, active: true, recurring: { interval: "month" }, lookup_key: null, metadata: {} }
  );
}
seedLegacy();
const priceById = (pid) => S.prices.find((p) => p.id === pid);
const fakeStripe = {
  prices: {
    async list({ lookup_keys, active }) {
      return { data: S.prices.filter((p) => lookup_keys.includes(p.lookup_key) && (active === undefined || p.active === active)) };
    },
    async retrieve(pid) {
      const p = priceById(pid);
      if (!p) throw new Error(`No such price: ${pid}`);
      return p;
    },
    async create(o) {
      if (o.transfer_lookup_key) for (const p of S.prices) if (p.lookup_key === o.lookup_key) p.lookup_key = null;
      const p = { id: id("price"), active: true, ...o };
      S.prices.push(p);
      return p;
    },
    async update(pid, o) {
      Object.assign(priceById(pid), o);
      return priceById(pid);
    },
  },
  products: {
    async search() { return { data: [] }; },
    async create(o) { const p = { id: id("prod"), ...o }; S.products.push(p); return p; },
    async update(pid, o) { const p = S.products.find((x) => x.id === pid); Object.assign(p, o); return p; },
  },
  customers: { async create(o) { const c = { id: id("cus"), ...o }; S.customers.push(c); return c; } },
  checkout: { sessions: { async create(o) { const s = { id: id("cs"), url: `https://checkout.stripe.test/${seq}`, ...o }; S.sessions.push(s); return s; } } },
  subscriptions: {
    async retrieve(sid) { return S.subs.get(sid); },
    async update(sid, o) {
      const sub = S.subs.get(sid);
      S.updates.push({ sid, ...o });
      if (o.items) {
        for (const it of o.items) {
          const item = sub.items.data.find((x) => x.id === it.id);
          item.price = priceById(it.price);
        }
      }
      if (o.cancel_at_period_end !== undefined) sub.cancel_at_period_end = o.cancel_at_period_end;
      if (o.metadata) sub.metadata = o.metadata;
      return sub;
    },
    async list({ status }) { return { data: [...S.subs.values()].filter((x) => x.status === status), has_more: false }; },
  },
  billingPortal: { sessions: { async create() { return { url: "https://billing.stripe.test/portal" }; } } },
  webhooks: { constructEvent(body) { return JSON.parse(Buffer.isBuffer(body) ? body.toString() : body); } },
};
function makeSub({ customer, priceId, status = "active" }) {
  const sub = {
    id: id("sub"),
    customer,
    status,
    cancel_at_period_end: false,
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
    metadata: {},
    items: { data: [{ id: id("si"), price: priceById(priceId) }] },
  };
  S.subs.set(sub.id, sub);
  return sub;
}

// Anthropic (AI chat) — always a short answer.
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("api.anthropic.com")) {
    return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "Here's the read on that game." }] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
};

const { pool, ensureSchema } = await import("../src/db.js");
const stripeSvc = await import("../src/services/stripeService.js");
stripeSvc.__setStripe(fakeStripe);
const { default: authRouter } = await import("../src/routes/auth.js");
const billing = await import("../src/routes/billing.js");
const { default: adminRouter } = await import("../src/routes/admin.js");
const { default: chatRouter } = await import("../src/routes/chat.js");
const { effectiveTier, TRIAL_DAYS } = await import("../src/services/tierService.js");

// Fresh schema for every run.
await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
await ensureSchema();

const app = express();
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), billing.handleStripeWebhook);
app.use(express.json({ limit: "15mb" }));
app.use("/api/auth", authRouter);
app.use("/api/billing", billing.default);
app.use("/api/admin", adminRouter);
app.use("/api/chat", chatRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
function call(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(base + path, { method, headers: { "content-type": "application/json", ...headers } }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : {} }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const as = (token) => ({ authorization: `Bearer ${token}` });
const admin = { "x-admin-key": "admin-test" };
const webhook = (event) => call("POST", "/api/billing/webhook", event, { "stripe-signature": "t=1,v1=fake" });
const userRow = async (uid) => (await pool.query("SELECT * FROM users WHERE id = $1", [uid])).rows[0];
let n = 0;
async function newUser() {
  const r = await call("POST", "/api/auth/signup", { email: `user${++n}@test.dev`, password: "password123" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { id: r.json.user.id, token: r.json.token, user: r.json.user };
}
// Runs a completed checkout through the same webhooks Stripe would send.
async function completeCheckout(u, session) {
  const sub = makeSub({ customer: session.customer, priceId: session.line_items[0].price, status: session.subscription_data?.trial_end ? "trialing" : "active" });
  await webhook({ type: "checkout.session.completed", data: { object: { mode: "subscription", customer: session.customer, subscription: sub.id, metadata: session.metadata } } });
  await webhook({ type: "customer.subscription.created", data: { object: sub } });
  return sub;
}

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

await test("pricing endpoint: new names, monthly + annual prices, Free plan, 7-day trial", async () => {
  const r = await call("GET", "/api/billing/tiers");
  assert.deepEqual(r.json.tiers.map((t) => [t.id, t.name, t.priceCents, t.annualPriceCents]), [
    ["standard", "Edge", 1499, 14900],
    ["edge", "Edge+", 2499, 24900],
    ["edge_pro", "Edge Pro", 3999, 39900],
  ]);
  assert.equal(r.json.free.priceCents, 0);
  assert.equal(r.json.trialDays, 7);
  assert.equal(r.json.tiers.find((t) => t.id === "edge").popular, true);
});

await test("checkout before Stripe setup gives a clear 'not set up' error (no crash)", async () => {
  const u = await newUser();
  const r = await call("POST", "/api/billing/checkout", { tier: "standard", interval: "monthly" }, as(u.token));
  assert.equal(r.status, 503);
  assert.match(r.json.error, /isn't set up in Stripe yet/);
});

await test("admin setup creates 6 prices, archives legacy for new sales, and is safe to re-run", async () => {
  const r = await call("POST", "/api/admin/stripe/setup-pricing", {}, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.created.length, 6);
  assert.equal(r.json.archived.length, 3);
  assert.equal(priceById("price_legacy_std").active, false);
  const amounts = r.json.created.map((c) => `${c.tier}:${c.interval}:${c.amount}`).sort();
  assert.deepEqual(amounts, ["edge:annual:24900", "edge:monthly:2499", "edge_pro:annual:39900", "edge_pro:monthly:3999", "standard:annual:14900", "standard:monthly:1499"].sort());
  const again = await call("POST", "/api/admin/stripe/setup-pricing", {}, admin);
  assert.equal(again.json.created.length, 0);
  assert.equal(again.json.reused.length, 6);
  const health = await call("GET", "/api/admin/billing-health", null, admin);
  assert.ok(health.json.tiers.every((t) => t.monthlyConfigured && t.annualConfigured));
});

await test("1. Free signup: account starts a 7-day trial, then falls back to Free", async () => {
  const u = await newUser();
  const row = await userRow(u.id);
  assert.equal(row.tier, "trial");
  const days = (new Date(row.trial_ends_at) - Date.now()) / 86400000;
  assert.ok(days > 6.9 && days <= 7.01, `trial days ${days}`);
  assert.equal(effectiveTier(row), "trial");
  await pool.query("UPDATE users SET trial_ends_at = now() - interval '1 minute' WHERE id = $1", [u.id]);
  assert.equal(effectiveTier(await userRow(u.id)), "expired");
});

await test("Free plan: 3 AI questions a day, then an upgrade prompt (and logged-out needs an account)", async () => {
  const u = await newUser();
  await pool.query("UPDATE users SET trial_ends_at = now() - interval '1 minute' WHERE id = $1", [u.id]);
  for (let i = 0; i < 3; i++) {
    const r = await call("POST", "/api/chat", { message: "Who wins?" }, as(u.token));
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  await new Promise((r) => setTimeout(r, 150)); // usage rows are written on finish
  const blocked = await call("POST", "/api/chat", { message: "Who wins?" }, as(u.token));
  assert.equal(blocked.status, 402);
  assert.equal(blocked.json.limitReached, true);
  assert.equal(blocked.json.requiredTier, "standard");
  assert.match(blocked.json.error, /3 AI questions/);
  const anon = await call("POST", "/api/chat", { message: "hi" });
  assert.equal(anon.status, 402);
  assert.equal(anon.json.loggedIn, false);
});

for (const [tier, name, monthly, annual] of [["standard", "Edge", 1499, 14900], ["edge", "Edge+", 2499, 24900], ["edge_pro", "Edge Pro", 3999, 39900]]) {
  for (const interval of ["monthly", "annual"]) {
    const num = interval === "monthly" ? { standard: 2, edge: 3, edge_pro: 4 }[tier] : 5;
    await test(`${num}. ${name} ${interval} checkout → correct Stripe price → webhook sets plan`, async () => {
      const u = await newUser();
      await pool.query("UPDATE users SET trial_ends_at = now() - interval '1 minute' WHERE id = $1", [u.id]); // trial used up
      const r = await call("POST", "/api/billing/checkout", { tier, interval }, as(u.token));
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const session = S.sessions[S.sessions.length - 1];
      const price = priceById(session.line_items[0].price);
      assert.equal(price.unit_amount, interval === "monthly" ? monthly : annual);
      assert.equal(price.recurring.interval, interval === "monthly" ? "month" : "year");
      assert.equal(session.metadata.tier, tier);
      assert.equal(session.subscription_data.trial_end, undefined, "trial already used — billing starts now");
      await completeCheckout(u, session);
      const row = await userRow(u.id);
      assert.equal(row.tier, tier);
      assert.equal(row.billing_interval, interval);
      assert.equal(row.subscription_status, "active");
      assert.equal(effectiveTier(row), tier);
      const me = await call("GET", "/api/auth/me", null, as(u.token));
      assert.equal(me.json.user.billingInterval, interval);
    });
  }
}

await test("6. Subscribing during the 7-day trial: no charge until the trial ends", async () => {
  const u = await newUser();
  const r = await call("POST", "/api/billing/checkout", { tier: "edge", interval: "monthly" }, as(u.token));
  assert.equal(r.status, 200);
  const session = S.sessions[S.sessions.length - 1];
  const row = await userRow(u.id);
  assert.equal(session.subscription_data.trial_end, Math.floor(new Date(row.trial_ends_at).getTime() / 1000));
  await completeCheckout(u, session);
  const after = await userRow(u.id);
  assert.equal(after.tier, "edge");
  assert.equal(after.subscription_status, "trialing");
  assert.equal(effectiveTier(after), "edge");
});

await test("7. Upgrade / downgrade / monthly→annual switch the same subscription with proration", async () => {
  const u = await newUser();
  await pool.query("UPDATE users SET trial_ends_at = now() - interval '1 minute' WHERE id = $1", [u.id]);
  await call("POST", "/api/billing/checkout", { tier: "standard", interval: "monthly" }, as(u.token));
  const sub = await completeCheckout(u, S.sessions[S.sessions.length - 1]);

  const up = await call("POST", "/api/billing/change-plan", { tier: "edge_pro", interval: "monthly" }, as(u.token));
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.direction, "upgrade");
  assert.equal((await userRow(u.id)).tier, "edge_pro");
  let last = S.updates[S.updates.length - 1];
  assert.equal(last.proration_behavior, "create_prorations");
  assert.equal(priceById(last.items[0].price).unit_amount, 3999);

  const down = await call("POST", "/api/billing/change-plan", { tier: "edge", interval: "monthly" }, as(u.token));
  assert.equal(down.json.direction, "downgrade");
  assert.equal((await userRow(u.id)).tier, "edge");

  const yearly = await call("POST", "/api/billing/change-plan", { tier: "edge", interval: "annual" }, as(u.token));
  assert.equal(yearly.json.direction, "interval");
  const row = await userRow(u.id);
  assert.equal(row.billing_interval, "annual");
  assert.equal(S.subs.size >= 1, true);
  assert.equal(row.stripe_subscription_id, sub.id, "still one subscription");

  // Choosing a plan via checkout while subscribed also changes in place.
  const viaCheckout = await call("POST", "/api/billing/checkout", { tier: "standard", interval: "monthly" }, as(u.token));
  assert.equal(viaCheckout.json.changed, true);
  assert.equal((await userRow(u.id)).tier, "standard");
});

await test("8. Cancellation: keeps access until period end, then drops to Free; stale events can't downgrade", async () => {
  const u = await newUser();
  await pool.query("UPDATE users SET trial_ends_at = now() - interval '1 minute' WHERE id = $1", [u.id]);
  await call("POST", "/api/billing/checkout", { tier: "edge", interval: "annual" }, as(u.token));
  const sub = await completeCheckout(u, S.sessions[S.sessions.length - 1]);
  const c = await call("POST", "/api/billing/cancel", {}, as(u.token));
  assert.equal(c.status, 200, JSON.stringify(c.json));
  let row = await userRow(u.id);
  assert.equal(row.cancel_at_period_end, true);
  assert.equal(effectiveTier(row), "edge", "still has access until the period ends");
  const resume = await call("POST", "/api/billing/resume", {}, as(u.token));
  assert.equal(resume.status, 200);
  assert.equal((await userRow(u.id)).cancel_at_period_end, false);

  // A stale "deleted" event for some older subscription doesn't touch this one.
  await webhook({ type: "customer.subscription.deleted", data: { object: { id: "sub_old_unrelated", customer: sub.customer } } });
  assert.equal(effectiveTier(await userRow(u.id)), "edge");
  // The real end of the subscription does.
  await webhook({ type: "customer.subscription.deleted", data: { object: { ...sub, status: "canceled" } } });
  row = await userRow(u.id);
  assert.equal(row.subscription_status, "canceled");
  assert.equal(effectiveTier(row), "expired");
  const portal = await call("POST", "/api/billing/portal", {}, as(u.token));
  assert.equal(portal.json.url, "https://billing.stripe.test/portal");
});

await test("10. Webhooks: legacy prices still map to the right plan; unknown prices never change the plan", async () => {
  const u = await newUser();
  await pool.query("UPDATE users SET stripe_customer_id = 'cus_legacy', tier = 'edge_pro', subscription_status = 'active' WHERE id = $1", [u.id]);
  const legacySub = makeSub({ customer: "cus_legacy", priceId: "price_legacy_std" });
  await webhook({ type: "customer.subscription.updated", data: { object: legacySub } });
  assert.equal((await userRow(u.id)).tier, "standard", "legacy $19.99 price = Edge plan");
  S.prices.push({ id: "price_mystery", unit_amount: 777, recurring: { interval: "month" }, metadata: {} });
  const mystery = makeSub({ customer: "cus_legacy", priceId: "price_mystery", status: "past_due" });
  await webhook({ type: "customer.subscription.updated", data: { object: mystery } });
  const row = await userRow(u.id);
  assert.equal(row.tier, "standard", "unknown price leaves plan unchanged");
  assert.equal(row.subscription_status, "past_due");
});

await test("Existing subscribers: dry run lists them; live run moves them to the new price at next renewal only", async () => {
  // Only legacy subscriptions still active should be considered.
  for (const s of S.subs.values()) if (s.items.data[0].price.id === "price_mystery") s.status = "canceled";
  const legacy = [...S.subs.values()].filter((s) => s.items.data[0].price.id.startsWith("price_legacy") && s.status === "active");
  assert.ok(legacy.length >= 1);
  const updatesBefore = S.updates.length;
  const dry = await call("POST", "/api/admin/stripe/migrate-subscribers", { dryRun: true }, admin);
  assert.equal(dry.status, 200, JSON.stringify(dry.json));
  assert.equal(dry.json.moved.length, legacy.length);
  assert.equal(S.updates.length, updatesBefore, "dry run changes nothing");
  const live = await call("POST", "/api/admin/stripe/migrate-subscribers", { dryRun: false }, admin);
  assert.equal(live.json.moved.length, legacy.length);
  const upd = S.updates.slice(updatesBefore);
  assert.ok(upd.every((x) => x.proration_behavior === "none"), "no mid-cycle charge or credit");
  assert.equal(priceById(upd[0].items[0].price).unit_amount, 1499);
  assert.equal(legacy[0].status, "active");
});

server.close();
await pool.end();
if (failures) {
  console.log(`\n${failures} billing test(s) failed`);
  process.exit(1);
}
console.log("\nAll billing tests passed");
