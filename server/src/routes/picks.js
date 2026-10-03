import { Router } from "express";
import crypto from "node:crypto";
import { pool, ensureSchema } from "../db.js";
import { buildLeaderboard, rangeFilter, toPublic, toCsv, pickersDisagree, viewFor, isRevealed } from "../services/picksService.js";
import { withTier } from "../middleware/tier.js";
import { savePick, gradePick, hasPickAccess } from "../services/ledgerService.js";
import { runPickers, runDailyIfDue } from "../services/pickerService.js";

// Public picks ledger. Writes (ingest, grade) need PICKS_INGEST_TOKEN;
// everything else is public on purpose — it's the trust page.
const router = Router();

function requireIngestToken(req, res, next) {
  const want = process.env.PICKS_INGEST_TOKEN;
  if (!want) return res.status(503).json({ error: "Pick ingest isn't configured (set PICKS_INGEST_TOKEN)." });
  const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Invalid ingest token." });
  next();
}
function needDb(res) {
  if (pool) return false;
  res.status(503).json({ error: "The picks ledger needs a database." });
  return true;
}

// POST /api/picks/ingest — one pick or an array. Idempotent on
// (picker, game, bet, kickoff_at): re-sending returns the original row.
router.post("/ingest", requireIngestToken, async (req, res) => {
  if (needDb(res)) return;
  const list = Array.isArray(req.body) ? req.body : [req.body];
  if (!list.length || list.length > 200) return res.status(400).json({ error: "Send 1–200 picks." });
  try {
    const results = [];
    for (const raw of list) results.push(await savePick(raw));
    const anyOk = results.some((r) => r.status !== "rejected");
    res.status(anyOk ? 200 : 400).json(Array.isArray(req.body) ? { results } : results[0]);
  } catch (err) {
    console.error("picks ingest:", err);
    res.status(500).json({ error: "Couldn't save picks." });
  }
});

// POST /api/picks/grade — { id, result, closing_odds? } (or an array).
// Units are computed here; only pending picks can be graded.
router.post("/grade", requireIngestToken, async (req, res) => {
  if (needDb(res)) return;
  const list = Array.isArray(req.body) ? req.body : [req.body];
  try {
    const results = [];
    for (const g of list) results.push(await gradePick(g || {}));
    const anyOk = results.some((r) => r.status === "graded");
    res.status(anyOk ? 200 : (results.some((r) => /already graded/.test(r.error || "")) ? 409 : 400)).json(Array.isArray(req.body) ? { results } : results[0]);
  } catch (err) {
    console.error("picks grade:", err);
    res.status(500).json({ error: "Couldn't grade picks." });
  }
});

// POST /api/picks/run — run the three built-in pickers: pick games starting
// in the next 24h and grade finished ones.
// Body: { daily: true } = the scheduled once-a-day run (no-op if today's
// already done or it's before the run hour); otherwise runs now.
// { dry: true } previews without saving; post/grade: false skip a half.
router.post("/run", requireIngestToken, async (req, res) => {
  if (needDb(res)) return;
  try {
    if (req.body?.daily) return res.json(await runDailyIfDue());
    res.json(await runPickers({ dryRun: !!req.body?.dry, post: req.body?.post !== false, grade: req.body?.grade !== false }));
  } catch (err) {
    console.error("picks run:", err);
    res.status(500).json({ error: "Picker run failed.", detail: err.message });
  }
});

// Shared filters for the list + CSV.
function whereFor(q) {
  const cond = [], params = [];
  const add = (sql, v) => { params.push(v); cond.push(sql.replace("?", `$${params.length}`)); };
  if (q.picker) add("picker = ?", String(q.picker));
  if (q.sport && q.sport !== "all") add("sport = ?", String(q.sport).toLowerCase());
  if (q.status === "pending") cond.push("result = 'pending'");
  else if (q.status === "graded") cond.push("result IN ('win','loss','push','void')");
  else if (["win", "loss", "push", "void"].includes(q.status)) add("result = ?", q.status);
  if (q.from && Number.isFinite(Date.parse(q.from))) add("kickoff_at >= ?", new Date(q.from).toISOString());
  if (q.to && Number.isFinite(Date.parse(q.to))) add("kickoff_at <= ?", new Date(q.to).toISOString());
  if (q.range && ["7d", "30d"].includes(q.range)) add("kickoff_at >= ?", new Date(Date.now() - (q.range === "7d" ? 7 : 30) * 86400e3).toISOString());
  return { where: cond.length ? `WHERE ${cond.join(" AND ")}` : "", params };
}

// GET /api/picks?picker=&sport=&status=&from=&to=&range=&page=&limit=
// Picks whose games haven't started are locked (picker, sport, posted time
// only) unless the viewer bought the current Hot Picks bundle.
router.get("/", withTier, async (req, res) => {
  if (!pool) return res.json({ available: false, picks: [], total: 0 });
  try {
    await ensureSchema();
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const { where, params } = whereFor(req.query);
    let { rows } = await pool.query(`SELECT * FROM picks ${where} ORDER BY kickoff_at DESC, id DESC`, params);
    if (req.query.range === "season") rows = rows.filter(rangeFilter("season"));
    const entitled = req.user ? await hasPickAccess(req.user.id) : false;
    const now = Date.now();
    const total = rows.length;
    const lockedCount = rows.filter((r) => !isRevealed(r, now)).length;
    res.json({
      available: true, total, page, limit, pages: Math.max(Math.ceil(total / limit), 1),
      access: { entitled, loggedIn: !!req.user, lockedCount },
      picks: rows.slice((page - 1) * limit, page * limit).map((r) => viewFor(r, { entitled, now })),
    });
  } catch (err) {
    console.error("picks list:", err);
    res.status(500).json({ error: "Couldn't load picks." });
  }
});

// GET /api/picks/leaderboard?range=7d|30d|season|all&sport=
router.get("/leaderboard", async (req, res) => {
  const range = ["7d", "30d", "season", "all"].includes(req.query.range) ? req.query.range : "all";
  if (!pool) return res.json({ available: false, range, pickers: buildLeaderboard([]) });
  try {
    await ensureSchema();
    const { where, params } = whereFor({ sport: req.query.sport });
    const { rows } = await pool.query(`SELECT * FROM picks ${where}`, params);
    const inRange = rows.filter(rangeFilter(range));
    res.json({ available: true, range, sport: req.query.sport || "all", generatedAt: new Date().toISOString(), pickers: buildLeaderboard(inRange) });
  } catch (err) {
    console.error("picks leaderboard:", err);
    res.status(500).json({ error: "Couldn't build the leaderboard." });
  }
});

// GET /api/picks/export.csv — the whole public ledger (same filters as the
// list, optional). Only revealed picks: one is added when its game starts.
router.get("/export.csv", async (req, res) => {
  if (needDb(res)) return;
  try {
    await ensureSchema();
    const { where, params } = whereFor(req.query);
    let { rows } = await pool.query(`SELECT * FROM picks ${where} ORDER BY kickoff_at DESC, id DESC`, params);
    if (req.query.range === "season") rows = rows.filter(rangeFilter("season"));
    rows = rows.filter((r) => isRevealed(r)); // the public ledger: picks are added once their games start
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="betedge-picks-ledger-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(toCsv(rows.map(toPublic)));
  } catch (err) {
    console.error("picks csv:", err);
    res.status(500).json({ error: "Couldn't export picks." });
  }
});

// GET /api/picks/game?sport=&game_id=&home=&away=&kickoff= — the pickers'
// picks on one game (by id, or by team names within 12h of kickoff), plus
// each picker's all-time record, for the game page and the AI chat.
// Not entitled + game not started: no picks at all (not even whether there
// are any — that would give away which games the pickers chose).
export async function picksForGame({ sport, gameId, home, away, kickoff, entitled = false }) {
  if (!pool) return { available: false, picks: [], records: [], disagree: false };
  await ensureSchema();
  const now = Date.now();
  const { rows: all } = await pool.query("SELECT * FROM picks");
  const records = buildLeaderboard(all).map(({ series, byConfidence, ...r }) => r);
  const t = Date.parse(kickoff);
  const started = Number.isFinite(t) && t <= now;
  if (!entitled && !started) return { available: true, hidden: true, picks: [], records, disagree: false };
  const params = [String(sport || "").toLowerCase()];
  const ors = [];
  if (gameId) { params.push(String(gameId)); ors.push(`game_id = $${params.length}`); }
  if (home && away && Number.isFinite(t)) {
    params.push(new Date(t - 12 * 3600e3).toISOString(), new Date(t + 12 * 3600e3).toISOString(), `%${String(home).toLowerCase()}%`, `%${String(away).toLowerCase()}%`);
    const n = params.length;
    ors.push(`(kickoff_at BETWEEN $${n - 3} AND $${n - 2} AND lower(game) LIKE $${n - 1} AND lower(game) LIKE $${n})`);
  }
  if (!ors.length) return { available: true, picks: [], records, disagree: false };
  let { rows } = await pool.query(`SELECT * FROM picks WHERE sport = $1 AND (${ors.join(" OR ")}) ORDER BY created_at`, params);
  if (!entitled) rows = rows.filter((r) => isRevealed(r, now));
  return { available: true, picks: rows.map((r) => viewFor(r, { entitled, now })), records, disagree: pickersDisagree(rows, home, away), early: entitled && !started };
}
router.get("/game", withTier, async (req, res) => {
  try {
    const entitled = req.user ? await hasPickAccess(req.user.id) : false;
    res.json(await picksForGame({ sport: req.query.sport, gameId: req.query.game_id, home: req.query.home, away: req.query.away, kickoff: req.query.kickoff, entitled }));
  } catch (err) {
    console.error("picks for game:", err);
    res.status(500).json({ error: "Couldn't load picks for this game." });
  }
});

export default router;
