// AI picks access integration test: real routes + real Postgres, Stripe faked.
// Pick Packs are no longer sold: Edge Pro and trial accounts see every pick,
// everyone else gets one free pick. Historic pack payments still fulfil.
// Needs a scratch database: TEST_DATABASE_URL=postgres://... node test/pickpacks.test.mjs
// (skipped when TEST_DATABASE_URL isn't set, so `npm test` still runs anywhere).
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";

if (!process.env.TEST_DATABASE_URL) {
  console.log("SKIP  pick pack tests (set TEST_DATABASE_URL to a scratch Postgres database to run them)");
  process.exit(0);
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DATABASE_SSL = "false";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
process.env.JWT_SECRET = "test-secret";

// ---- Fake Stripe ------------------------------------------------------------
let seq = 0;
const sid = (p) => `${p}_${++seq}`;
const S = { customers: [], sessions: new Map() };
const fakeStripe = {
  customers: { async create(o) { const c = { id: sid("cus"), ...o }; S.customers.push(c); return c; } },
  checkout: {
    sessions: {
      async create(o) {
        const s = { id: sid("cs_test"), url: `https://checkout.stripe.test/${seq}`, payment_status: "unpaid", amount_total: o.line_items[0].price_data?.unit_amount, currency: "usd", ...o };
        S.sessions.set(s.id, s);
        return s;
      },
      async retrieve(id) { const s = S.sessions.get(id); if (!s) throw new Error(`No such session: ${id}`); return s; },
    },
  },
  webhooks: { constructEvent(body) { return JSON.parse(Buffer.isBuffer(body) ? body.toString() : body); } },
};

const { pool, ensureSchema } = await import("../src/db.js");
const stripeSvc = await import("../src/services/stripeService.js");
stripeSvc.__setStripe(fakeStripe);
const { default: authRouter } = await import("../src/routes/auth.js");
const billing = await import("../src/routes/billing.js");
const { default: picksRouter } = await import("../src/routes/picks.js");
const { default: pickPacksRouter } = await import("../src/routes/pickPacks.js");
const { default: hotPicksRouter } = await import("../src/routes/hotpicks.js");

await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
await ensureSchema();

const app = express();
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), billing.handleStripeWebhook);
app.use(express.json());
app.use("/api/auth", authRouter);
app.use("/api/billing", billing.default);
app.use("/api/picks", picksRouter);
app.use("/api/pick-packs", pickPacksRouter);
app.use("/api/hot-picks", hotPicksRouter);
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
const webhook = (event) => call("POST", "/api/billing/webhook", event, { "stripe-signature": "t=1,v1=fake" });
const credits = async (uid) => (await pool.query("SELECT pick_credits FROM users WHERE id = $1", [uid])).rows[0].pick_credits;
let n = 0;
// New signups start on the trial (every pick free). Most tests want an
// account past its trial; pass { plan } to put it on a paid tier instead.
async function newUser(email, { plan = "expired" } = {}) {
  const r = await call("POST", "/api/auth/signup", { email: email || `pp${++n}@test.dev`, password: "password123" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const u = { id: r.json.user.id, token: r.json.token };
  await setPlan(u, plan);
  return u;
}
async function setPlan(u, plan) {
  if (plan === "trial") return;
  if (plan === "expired") return pool.query("UPDATE users SET tier='trial', trial_ends_at=now() - interval '1 day' WHERE id=$1", [u.id]);
  return pool.query("UPDATE users SET tier=$2, stripe_subscription_id='sub_' || id, subscription_status='active' WHERE id=$1", [u.id, plan]);
}
async function addPick({ picker = "Lone Wolf", game, kickoffHours = 6, result = "pending" }) {
  const kickoff = new Date(Date.now() + kickoffHours * 3600e3);
  const created = new Date(Math.min(Date.now(), kickoff.getTime()) - 3600e3);
  const { rows } = await pool.query(
    `INSERT INTO picks (picker, sport, game, game_id, kickoff_at, bet, odds, implied_prob, confidence, reason, created_at)
     VALUES ($1,'nfl',$2,$3,$4,'Denver Broncos +3',-110,0.5238,'High','Sharp money on Denver.',$5) RETURNING id`,
    [picker, game, game.toLowerCase().replace(/\W+/g, "-"), kickoff.toISOString(), created.toISOString()]
  );
  if (result !== "pending") await pool.query("UPDATE picks SET result=$2, units=0.91, graded_at=now() WHERE id=$1", [rows[0].id, result]);
  return Number(rows[0].id);
}
// Packs can't be bought any more; this stands in for a checkout that was
// started before they were retired, so fulfilment is still covered.
const { packById } = await import("../src/services/pickPackService.js");
async function paidSession(u, packId) {
  return stripeSvc.createPickPackCheckoutSession({
    customerId: "cus_legacy", userId: u.id, pack: packById(packId),
    successUrl: "https://betedgeai.com/record?pickpack=success&session_id={CHECKOUT_SESSION_ID}", cancelUrl: "https://betedgeai.com/record",
  });
}
const markPaid = (s) => Object.assign(s, { payment_status: "paid", status: "complete", payment_intent: sid("pi") });

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (err) { failures++; console.log(`FAIL  ${name}\n      ${err.stack || err.message}`); }
}

await test("packs are no longer for sale: empty list, checkout refused", async () => {
  const r = await call("GET", "/api/pick-packs");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.packs, []);
  assert.equal(r.json.packsForSale, false);
  assert.equal(r.json.freePick.priceCents, 0);
  assert.equal(r.json.account, undefined, "no account data when logged out");
  const u = await newUser();
  const c = await call("POST", "/api/pick-packs/checkout", { packId: "pack_5" }, as(u.token));
  assert.equal(c.status, 410);
  assert.equal(c.json.upgradeTier, "edge_pro");
  assert.equal(S.sessions.size, 0, "no Stripe session created");
});

await test("Hot Picks is retired: nothing on sale, purchase refused", async () => {
  const t = await call("GET", "/api/hot-picks/today");
  assert.equal(t.status, 200);
  assert.equal(t.json.available, false); assert.equal(t.json.retired, true);
  const u = await newUser(null, { plan: "edge" });
  const r = await call("POST", "/api/hot-picks/purchase", {}, as(u.token));
  assert.equal(r.status, 410);
  assert.equal(S.sessions.size, 0);
});

await test("trial: every picker's pick is free and early; no free pick to claim or credit to spend", async () => {
  const u = await newUser(null, { plan: "trial" });
  const p1 = await addPick({ game: "Trial A @ Trial B" });
  const p2 = await addPick({ picker: "The Fader", game: "Trial C @ Trial D" });
  const list = await call("GET", "/api/picks", null, as(u.token));
  assert.equal(list.json.access.entitled, true);
  assert.equal(list.json.access.via, "trial");
  for (const id of [p1, p2]) {
    const v = list.json.picks.find((p) => p.id === id);
    assert.equal(v.locked, false); assert.equal(v.early, true); assert.equal(v.bet, "Denver Broncos +3");
  }
  const sum = await call("GET", "/api/pick-packs", null, as(u.token));
  assert.equal(sum.json.account.allPicksIncluded, true);
  assert.equal(sum.json.account.allPicksVia, "trial");
  assert.equal(sum.json.account.freePick.eligible, false);
  assert.equal((await call("POST", "/api/pick-packs/claim-free", {}, as(u.token))).status, 409);
  const un = await call("POST", "/api/pick-packs/unlock", { pickId: p1 }, as(u.token));
  assert.equal(un.json.status, "entitled"); assert.equal(un.json.charged, false);
  const kick = new Date(Date.now() + 6 * 3600e3).toISOString();
  const g = await call("GET", `/api/picks/game?sport=nfl&game_id=trial-a-trial-b&kickoff=${kick}`, null, as(u.token));
  assert.equal(g.json.early, true); assert.equal(g.json.accessVia, "trial");
  // Trial ends -> back to locked, and the free pick is now claimable.
  await setPlan(u, "expired");
  const after = await call("GET", "/api/picks", null, as(u.token));
  assert.equal(after.json.access.entitled, false);
  assert.ok(after.json.picks.find((p) => p.id === p1).locked);
  assert.equal((await call("POST", "/api/pick-packs/claim-free", {}, as(u.token))).status, 200);
});

await test("Edge Pro: every pick free; Edge and Edge+ get exactly one free pick", async () => {
  const pro = await newUser(null, { plan: "edge_pro" });
  const p = await addPick({ game: "Pro A @ Pro B" });
  const list = await call("GET", "/api/picks", null, as(pro.token));
  assert.equal(list.json.access.entitled, true); assert.equal(list.json.access.via, "edge_pro");
  assert.equal(list.json.picks.find((x) => x.id === p).bet, "Denver Broncos +3");
  assert.equal((await call("POST", "/api/pick-packs/claim-free", {}, as(pro.token))).status, 409);
  // A lapsed Edge Pro subscription loses it.
  await pool.query("UPDATE users SET subscription_status='canceled' WHERE id=$1", [pro.id]);
  assert.equal((await call("GET", "/api/picks", null, as(pro.token))).json.access.entitled, false);

  for (const plan of ["standard", "edge"]) {
    const u = await newUser(null, { plan });
    const q1 = await addPick({ game: `${plan} A @ ${plan} B` });
    const q2 = await addPick({ picker: "The Professor", game: `${plan} C @ ${plan} D` });
    const l = await call("GET", "/api/picks", null, as(u.token));
    assert.equal(l.json.access.entitled, false, plan);
    const sum = await call("GET", "/api/pick-packs", null, as(u.token));
    assert.equal(sum.json.account.allPicksIncluded, false);
    assert.equal(sum.json.account.freePick.eligible, true);
    assert.equal((await call("POST", "/api/pick-packs/claim-free", {}, as(u.token))).status, 200);
    assert.equal((await call("POST", "/api/pick-packs/unlock", { pickId: q1 }, as(u.token))).json.charged, true);
    const out = await call("POST", "/api/pick-packs/unlock", { pickId: q2 }, as(u.token));
    assert.equal(out.status, 402); assert.equal(out.json.upgradeTier, "edge_pro");
  }
});

await test("free pick: needs an account, one per account, one per inbox, no card", async () => {
  assert.equal((await call("POST", "/api/pick-packs/claim-free", {})).status, 401);
  const u = await newUser("first.timer+a@gmail.com");
  let s = await call("GET", "/api/pick-packs", null, as(u.token));
  assert.equal(s.json.account.freePick.eligible, true);
  const r = await call("POST", "/api/pick-packs/claim-free", {}, as(u.token));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.credits, 1);
  assert.equal((await call("POST", "/api/pick-packs/claim-free", {}, as(u.token))).status, 409);
  assert.equal(await credits(u.id), 1);
  const twin = await newUser("firsttimer+b@gmail.com"); // same Gmail inbox
  const t = await call("POST", "/api/pick-packs/claim-free", {}, as(twin.token));
  assert.equal(t.status, 409);
  assert.equal(await credits(twin.id), 0);
  const me = await call("GET", "/api/auth/me", null, as(u.token));
  assert.equal(me.json.user.pickCredits, 1);
  assert.equal(me.json.user.freePickClaimed, true);
  assert.equal(S.customers.length, 0, "no Stripe customer / card involved");
});

await test("unlock: 1 credit opens the full pick, re-viewing is free, others stay locked", async () => {
  const u = await newUser();
  await call("POST", "/api/pick-packs/claim-free", {}, as(u.token));
  const p1 = await addPick({ game: "Denver Broncos @ Kansas City Chiefs" });
  const p2 = await addPick({ picker: "The Professor", game: "Buffalo Bills @ Miami Dolphins" });
  let list = await call("GET", "/api/picks", null, as(u.token));
  assert.equal(list.json.access.credits, 1);
  assert.ok(list.json.picks.find((p) => p.id === p1).locked);
  assert.equal(list.json.picks.find((p) => p.id === p1).bet, undefined, "locked pick hides the bet");
  const lockedBefore = list.json.access.lockedCount;

  const r = await call("POST", "/api/pick-packs/unlock", { pickId: p1 }, as(u.token));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.charged, true);
  assert.equal(r.json.credits, 0);
  assert.equal(r.json.pick.bet, "Denver Broncos +3");
  assert.equal(r.json.pick.reason, "Sharp money on Denver.");

  const again = await call("POST", "/api/pick-packs/unlock", { pickId: p1 }, as(u.token));
  assert.equal(again.json.status, "already_unlocked");
  assert.equal(again.json.charged, false);
  assert.equal(await credits(u.id), 0);

  list = await call("GET", "/api/picks", null, as(u.token));
  const v1 = list.json.picks.find((p) => p.id === p1), v2 = list.json.picks.find((p) => p.id === p2);
  assert.equal(v1.locked, false); assert.equal(v1.unlocked, true); assert.equal(v1.bet, "Denver Broncos +3");
  assert.equal(v2.locked, true);
  assert.equal(list.json.access.lockedCount, lockedBefore - 1);

  const kick = new Date(Date.now() + 6 * 3600e3).toISOString();
  const g = await call("GET", `/api/picks/game?sport=nfl&game_id=denver-broncos-kansas-city-chiefs&kickoff=${kick}`, null, as(u.token));
  assert.equal(g.json.hidden, undefined);
  assert.deepEqual(g.json.picks.map((p) => p.id), [p1]);
  const g2 = await call("GET", `/api/picks/game?sport=nfl&game_id=buffalo-bills-miami-dolphins&kickoff=${kick}`, null, as(u.token));
  assert.equal(g2.json.hidden, true, "a game with nothing unlocked still reveals nothing");
  const anon = await call("GET", `/api/picks/game?sport=nfl&game_id=denver-broncos-kansas-city-chiefs&kickoff=${kick}`);
  assert.equal(anon.json.hidden, true, "unlocks are per user");

  const out = await call("POST", "/api/pick-packs/unlock", { pickId: p2 }, as(u.token));
  assert.equal(out.status, 402);
  assert.equal(out.json.needCredits, true);
});

await test("unlock never charges for a pick that's already public", async () => {
  const u = await newUser();
  await call("POST", "/api/pick-packs/claim-free", {}, as(u.token));
  const done = await addPick({ game: "Old Game A @ Old Game B", kickoffHours: -3, result: "win" });
  const r = await call("POST", "/api/pick-packs/unlock", { pickId: done }, as(u.token));
  assert.equal(r.json.status, "public");
  assert.equal(r.json.charged, false);
  assert.equal(await credits(u.id), 1);
});

await test("double-tap / concurrent unlocks can't overspend", async () => {
  const u = await newUser();
  await call("POST", "/api/pick-packs/claim-free", {}, as(u.token));
  const a = await addPick({ game: "Race A @ Race B" });
  const b = await addPick({ picker: "The Fader", game: "Race C @ Race D" });
  const rs = await Promise.all([a, a, b, b, a].map((pickId) => call("POST", "/api/pick-packs/unlock", { pickId }, as(u.token))));
  assert.equal(rs.filter((r) => r.json.charged).length, 1, "exactly one credit spent");
  assert.equal(await credits(u.id), 0);
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM pick_unlocks WHERE user_id=$1", [u.id]);
  assert.equal(rows[0].n, 1);
});

await test("webhook: unpaid ignored, paid grants once, replays and races grant nothing more", async () => {
  const u = await newUser();
  const s = await paidSession(u, "pack_10");
  await webhook({ type: "checkout.session.completed", data: { object: { ...s } } }); // still unpaid
  assert.equal(await credits(u.id), 0);
  markPaid(s);
  const r = await webhook({ type: "checkout.session.completed", data: { object: s } });
  assert.equal(r.status, 200);
  assert.equal(await credits(u.id), 10);
  await Promise.all(Array.from({ length: 6 }, () => webhook({ type: "checkout.session.completed", data: { object: s } })));
  await webhook({ type: "checkout.session.async_payment_succeeded", data: { object: s } });
  const c = await call("POST", "/api/pick-packs/confirm", { sessionId: s.id }, as(u.token));
  assert.equal(c.json.confirmed, true); assert.equal(c.json.added, 0);
  assert.equal(await credits(u.id), 10, "still exactly 10");
  const sum = await call("GET", "/api/pick-packs", null, as(u.token));
  assert.equal(sum.json.account.purchases.length, 1);
  assert.deepEqual([sum.json.account.purchases[0].credits, sum.json.account.purchases[0].amountCents], [10, 4999]);
  const { rows } = await pool.query("SELECT delta, reason, balance_after FROM pick_credit_transactions WHERE user_id=$1", [u.id]);
  assert.deepEqual(rows, [{ delta: 10, reason: "purchase", balance_after: 10 }]);
});

await test("confirm: balance updates on return even if the webhook hasn't arrived; webhook later adds nothing", async () => {
  const u = await newUser();
  await call("POST", "/api/pick-packs/claim-free", {}, as(u.token));
  const s = await paidSession(u, "pack_3");
  const early = await call("POST", "/api/pick-packs/confirm", { sessionId: s.id }, as(u.token));
  assert.equal(early.status, 202); assert.equal(early.json.pending, true);
  markPaid(s);
  const c = await call("POST", "/api/pick-packs/confirm", { sessionId: s.id }, as(u.token));
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(c.json.added, 3);
  assert.equal(c.json.account.credits, 4);
  await webhook({ type: "checkout.session.completed", data: { object: s } });
  assert.equal(await credits(u.id), 4);
  const other = await newUser();
  const stolen = await call("POST", "/api/pick-packs/confirm", { sessionId: s.id }, as(other.token));
  assert.equal(stolen.status, 404, "can't claim someone else's purchase");
  assert.equal(await credits(other.id), 0);
});

await test("Edge Pro nudge: after a (legacy) pack purchase, gone once on Edge Pro", async () => {
  const u = await newUser();
  let sum = await call("GET", "/api/pick-packs", null, as(u.token));
  assert.equal(sum.json.account.showUpgrade, false);
  const s = markPaid(await paidSession(u, "pack_3"));
  await webhook({ type: "checkout.session.completed", data: { object: s } });
  sum = await call("GET", "/api/pick-packs", null, as(u.token));
  assert.equal(sum.json.account.showUpgrade, true);
  await setPlan(u, "edge");
  sum = await call("GET", "/api/pick-packs", null, as(u.token));
  assert.equal(sum.json.account.showUpgrade, true, "Edge+ still doesn't include every pick");
  await setPlan(u, "edge_pro");
  sum = await call("GET", "/api/pick-packs", null, as(u.token));
  assert.equal(sum.json.account.showUpgrade, false);
  assert.equal(sum.json.account.credits, 3, "credits stay after subscribing");
});

await test("existing flows untouched: subscription checkout webhook and Hot Picks purchase webhook", async () => {
  const u = await newUser();
  await webhook({ type: "checkout.session.completed", data: { object: { mode: "subscription", customer: "cus_sub", subscription: "sub_1", metadata: { betedgeUserId: String(u.id), tier: "edge", interval: "monthly" } } } });
  const row = (await pool.query("SELECT tier, subscription_status, pick_credits FROM users WHERE id=$1", [u.id])).rows[0];
  assert.deepEqual(row, { tier: "edge", subscription_status: "active", pick_credits: 0 });
  const { rows: d } = await pool.query("INSERT INTO hot_pick_days (bet_date) VALUES (CURRENT_DATE) RETURNING id");
  await webhook({ type: "checkout.session.completed", data: { object: { mode: "payment", payment_intent: "pi_hot", amount_total: 2500, metadata: { betedgeUserId: String(u.id), hotPickDayId: String(d[0].id) } } } });
  const { rows: hp } = await pool.query("SELECT COUNT(*)::int AS n FROM hot_pick_purchases WHERE user_id=$1", [u.id]);
  assert.equal(hp[0].n, 1);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM pick_pack_purchases WHERE user_id=$1", [u.id])).rows[0].n, 0);
  // A Hot Picks buyer already sees early picks — unlocking costs nothing.
  const p = await addPick({ game: "Hot A @ Hot B" });
  const r = await call("POST", "/api/pick-packs/unlock", { pickId: p }, as(u.token));
  assert.equal(r.json.status, "entitled"); assert.equal(r.json.charged, false);
});

server.close();
await pool.end();
if (failures) {
  console.log(`\n${failures} pick pack test(s) failed`);
  process.exit(1);
}
console.log("\nAll pick pack tests passed");
