import { Router } from "express";
import { pool, ensureSchema } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

// Favorites tab: games a user starred. Free for every logged-in user.
// Signed-out visitors keep stars on their device only (handled in the app)
// and those are merged in here when they log in (POST /api/favorites/sync).
const router = Router();
router.use(requireAuth);

const SPORTS = new Set(["nfl", "nba", "mlb", "ncaaf", "ncaab"]);
const MAX_FAVORITES = 200;
// Stars on games that started more than this long ago are cleaned up —
// the tab only shows finished games for 24 hours.
const KEEP_MS = 48 * 60 * 60 * 1000;

function clean(body) {
  const sport = String(body?.sport || "").toLowerCase();
  const gameId = String(body?.gameId || "").trim();
  if (!SPORTS.has(sport) || !gameId || gameId.length > 100) return null;
  const t = Date.parse(body?.commenceTime);
  return {
    sport,
    gameId,
    homeTeam: body?.homeTeam ? String(body.homeTeam).slice(0, 100) : null,
    awayTeam: body?.awayTeam ? String(body.awayTeam).slice(0, 100) : null,
    commenceTime: Number.isFinite(t) ? new Date(t).toISOString() : null,
  };
}

function toJson(r) {
  return {
    sport: r.sport,
    gameId: r.game_id,
    homeTeam: r.home_team,
    awayTeam: r.away_team,
    commenceTime: r.commence_time ? new Date(r.commence_time).toISOString() : null,
  };
}

async function listFor(userId) {
  await pool.query(
    "DELETE FROM user_favorites WHERE user_id = $1 AND commence_time < $2",
    [userId, new Date(Date.now() - KEEP_MS).toISOString()]
  );
  const { rows } = await pool.query(
    "SELECT * FROM user_favorites WHERE user_id = $1 ORDER BY commence_time NULLS LAST",
    [userId]
  );
  return rows.map(toJson);
}

async function add(userId, f) {
  await pool.query(
    `INSERT INTO user_favorites (user_id, sport, game_id, home_team, away_team, commence_time)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, sport, game_id) DO UPDATE
       SET home_team = COALESCE(EXCLUDED.home_team, user_favorites.home_team),
           away_team = COALESCE(EXCLUDED.away_team, user_favorites.away_team),
           commence_time = COALESCE(EXCLUDED.commence_time, user_favorites.commence_time)`,
    [userId, f.sport, f.gameId, f.homeTeam, f.awayTeam, f.commenceTime]
  );
}

async function count(userId) {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM user_favorites WHERE user_id = $1", [userId]);
  return rows[0].n;
}

function noDb(res) {
  return res.status(503).json({ error: "Favorites aren't available right now." });
}

// GET /api/favorites -> { favorites: [{ sport, gameId, homeTeam, awayTeam, commenceTime }] }
router.get("/", async (req, res) => {
  if (!pool) return noDb(res);
  try {
    await ensureSchema();
    res.json({ favorites: await listFor(req.user.id) });
  } catch (err) {
    console.error("favorites list:", err);
    res.status(500).json({ error: "Couldn't load favorites." });
  }
});

// POST /api/favorites { sport, gameId, homeTeam, awayTeam, commenceTime }
router.post("/", async (req, res) => {
  if (!pool) return noDb(res);
  const f = clean(req.body);
  if (!f) return res.status(400).json({ error: "Missing or invalid game." });
  try {
    await ensureSchema();
    if ((await count(req.user.id)) >= MAX_FAVORITES) {
      return res.status(400).json({ error: `You can star up to ${MAX_FAVORITES} games.` });
    }
    await add(req.user.id, f);
    res.json({ ok: true, favorites: await listFor(req.user.id) });
  } catch (err) {
    console.error("favorites add:", err);
    res.status(500).json({ error: "Couldn't save that favorite." });
  }
});

// POST /api/favorites/sync { favorites: [...] } — merge stars made while
// signed out into the account, then return the full list.
router.post("/sync", async (req, res) => {
  if (!pool) return noDb(res);
  const list = Array.isArray(req.body?.favorites) ? req.body.favorites.slice(0, 50) : [];
  try {
    await ensureSchema();
    let room = MAX_FAVORITES - (await count(req.user.id));
    for (const item of list) {
      if (room <= 0) break;
      const f = clean(item);
      if (!f) continue;
      await add(req.user.id, f);
      room--;
    }
    res.json({ ok: true, favorites: await listFor(req.user.id) });
  } catch (err) {
    console.error("favorites sync:", err);
    res.status(500).json({ error: "Couldn't sync favorites." });
  }
});

// DELETE /api/favorites/:sport/:gameId
router.delete("/:sport/:gameId", async (req, res) => {
  if (!pool) return noDb(res);
  try {
    await ensureSchema();
    await pool.query(
      "DELETE FROM user_favorites WHERE user_id = $1 AND sport = $2 AND game_id = $3",
      [req.user.id, String(req.params.sport).toLowerCase(), String(req.params.gameId)]
    );
    res.json({ ok: true, favorites: await listFor(req.user.id) });
  } catch (err) {
    console.error("favorites delete:", err);
    res.status(500).json({ error: "Couldn't remove that favorite." });
  }
});

export default router;
