import { Router } from "express";
import crypto from "node:crypto";
import { pool, ensureSchema } from "../db.js";
import {
  PICKERS, CONFIDENCES, SPORTS, impliedProb, validOdds, unitsFor, buildLeaderboard,
  rangeFilter, toPublic, toCsv, pickersDisagree,
} from "../services/picksService.js";

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

// Validate one incoming pick. Returns { value } or { error }.
function cleanPick(p) {
  if (!p || typeof p !== "object") return { error: "Pick must be an object." };
  const picker = String(p.picker || "").trim();
  if (!PICKERS.includes(picker)) return { error: `picker must be one of: ${PICKERS.join(", ")}.` };
  const sport = String(p.sport || "").toLowerCase().trim();
  if (!SPORTS.includes(sport)) return { error: `sport must be one of: ${SPORTS.join(", ")}.` };
  const game = String(p.game || "").trim();
  if (!game || game.length > 200) return { error: "game is required (e.g. \"Dallas Cowboys @ Kansas City Chiefs\")." };
  const kickoff = new Date(p.kickoff_at);
  if (!Number.isFinite(kickoff.getTime())) return { error: "kickoff_at must be an ISO date-time." };
  const bet = String(p.bet || "").trim();
  if (!bet || bet.length > 120) return { error: "bet is required (e.g. \"Denver Broncos +3\")." };
  if (!validOdds(p.odds)) return { error: "odds must be whole American odds like -110 or +150." };
  const confidence = String(p.confidence || "").trim();
  if (!CONFIDENCES.includes(confidence)) return { error: "confidence must be Low, Medium or High." };
  const reason = String(p.reason || "").trim();
  if (!reason || reason.length > 2000) return { error: "reason is required." };
  if (Date.now() >= kickoff.getTime()) return { error: "Pick rejected: it must be posted before kickoff." };
  const gameId = p.game_id ? String(p.game_id).slice(0, 100) : null;
  return { value: { picker, sport, game, gameId, kickoff: kickoff.toISOString(), bet, odds: Number(p.odds), implied: impliedProb(p.odds), confidence, reason } };
}

// POST /api/picks/ingest — one pick or an array. Idempotent on
// (picker, game, bet, kickoff_at): re-sending returns the original row.
router.post("/ingest", requireIngestToken, async (req, res) => {
  if (needDb(res)) return;
  const list = Array.isArray(req.body) ? req.body : [req.body];
  if (!list.length || list.length > 200) return res.status(400).json({ error: "Send 1–200 picks." });
  try {
    await ensureSchema();
    const results = [];
    for (const raw of list) {
      const { value: v, error } = cleanPick(raw);
      if (error) { results.push({ status: "rejected", error }); continue; }
      try {
        const ins = await pool.query(
          `INSERT INTO picks (picker, sport, game, game_id, kickoff_at, bet, odds, implied_prob, confidence, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (picker, game, bet, kickoff_at) DO NOTHING RETURNING *`,
          [v.picker, v.sport, v.game, v.gameId, v.kickoff, v.bet, v.odds, v.implied.toFixed(4), v.confidence, v.reason]
        );
        if (ins.rows.length) { results.push({ status: "created", pick: toPublic(ins.rows[0]) }); continue; }
        const { rows } = await pool.query(
          "SELECT * FROM picks WHERE picker=$1 AND game=$2 AND bet=$3 AND kickoff_at=$4",
          [v.picker, v.game, v.bet, v.kickoff]
        );
        results.push({ status: "duplicate", pick: rows[0] ? toPublic(rows[0]) : null });
      } catch (err) {
        // The DB's own before-kickoff check is the last line of defence.
        results.push({ status: "rejected", error: /picks_before_kickoff/.test(err.message) ? "Pick rejected: it must be posted before kickoff." : err.message });
      }
    }
    const anyOk = results.some((r) => r.status !== "rejected");
    const body = Array.isArray(req.body) ? { results } : results[0];
    res.status(anyOk ? 200 : 400).json(body);
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
    await ensureSchema();
    const results = [];
    for (const g of list) {
      const id = Number(g?.id);
      const result = String(g?.result || "").toLowerCase();
      if (!Number.isInteger(id) || id <= 0) { results.push({ status: "rejected", error: "id is required." }); continue; }
      if (!["win", "loss", "push", "void"].includes(result)) { results.push({ id, status: "rejected", error: "result must be win, loss, push or void." }); continue; }
      if (g.closing_odds != null && !validOdds(g.closing_odds)) { results.push({ id, status: "rejected", error: "closing_odds must be American odds like -115." }); continue; }
      const { rows: cur } = await pool.query("SELECT * FROM picks WHERE id=$1", [id]);
      if (!cur.length) { results.push({ id, status: "rejected", error: "No pick with that id." }); continue; }
      if (cur[0].result !== "pending") { results.push({ id, status: "rejected", error: `Pick ${id} is already graded (${cur[0].result}) and can't be changed.` }); continue; }
      const units = unitsFor(result, cur[0].odds);
      try {
        const { rows } = await pool.query(
          `UPDATE picks SET result=$2, units=$3, closing_odds=$4, graded_at=now()
           WHERE id=$1 AND result='pending' RETURNING *`,
          [id, result, units, g.closing_odds == null ? null : Number(g.closing_odds)]
        );
        if (!rows.length) results.push({ id, status: "rejected", error: `Pick ${id} is already graded and can't be changed.` });
        else results.push({ id, status: "graded", pick: toPublic(rows[0]) });
      } catch (err) {
        results.push({ id, status: "rejected", error: err.message });
      }
    }
    const anyOk = results.some((r) => r.status === "graded");
    res.status(anyOk ? 200 : (results.some((r) => /already graded/.test(r.error || "")) ? 409 : 400)).json(Array.isArray(req.body) ? { results } : results[0]);
  } catch (err) {
    console.error("picks grade:", err);
    res.status(500).json({ error: "Couldn't grade picks." });
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
router.get("/", async (req, res) => {
  if (!pool) return res.json({ available: false, picks: [], total: 0 });
  try {
    await ensureSchema();
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const { where, params } = whereFor(req.query);
    let { rows } = await pool.query(`SELECT * FROM picks ${where} ORDER BY kickoff_at DESC, id DESC`, params);
    if (req.query.range === "season") rows = rows.filter(rangeFilter("season"));
    const total = rows.length;
    res.json({ available: true, total, page, limit, pages: Math.max(Math.ceil(total / limit), 1), picks: rows.slice((page - 1) * limit, page * limit).map(toPublic) });
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

// GET /api/picks/export.csv — the whole public ledger (same filters as the list, optional).
router.get("/export.csv", async (req, res) => {
  if (needDb(res)) return;
  try {
    await ensureSchema();
    const { where, params } = whereFor(req.query);
    let { rows } = await pool.query(`SELECT * FROM picks ${where} ORDER BY kickoff_at DESC, id DESC`, params);
    if (req.query.range === "season") rows = rows.filter(rangeFilter("season"));
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
export async function picksForGame({ sport, gameId, home, away, kickoff }) {
  if (!pool) return { available: false, picks: [], records: [], disagree: false };
  await ensureSchema();
  const params = [String(sport || "").toLowerCase()];
  const ors = [];
  if (gameId) { params.push(String(gameId)); ors.push(`game_id = $${params.length}`); }
  const t = Date.parse(kickoff);
  if (home && away && Number.isFinite(t)) {
    params.push(new Date(t - 12 * 3600e3).toISOString(), new Date(t + 12 * 3600e3).toISOString(), `%${String(home).toLowerCase()}%`, `%${String(away).toLowerCase()}%`);
    const n = params.length;
    ors.push(`(kickoff_at BETWEEN $${n - 3} AND $${n - 2} AND lower(game) LIKE $${n - 1} AND lower(game) LIKE $${n})`);
  }
  if (!ors.length) return { available: true, picks: [], records: [], disagree: false };
  const { rows } = await pool.query(`SELECT * FROM picks WHERE sport = $1 AND (${ors.join(" OR ")}) ORDER BY created_at`, params);
  const { rows: all } = await pool.query("SELECT * FROM picks");
  const records = buildLeaderboard(all).map(({ series, byConfidence, ...r }) => r);
  return { available: true, picks: rows.map(toPublic), records, disagree: pickersDisagree(rows, home, away) };
}
router.get("/game", async (req, res) => {
  try {
    res.json(await picksForGame({ sport: req.query.sport, gameId: req.query.game_id, home: req.query.home, away: req.query.away, kickoff: req.query.kickoff }));
  } catch (err) {
    console.error("picks for game:", err);
    res.status(500).json({ error: "Couldn't load picks for this game." });
  }
});

export default router;
