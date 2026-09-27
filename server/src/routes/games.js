import { Router } from "express";
import { getOddsForSport, getScoresForSport } from "../services/oddsService.js";

const router = Router();

// GET /api/games/:sport  -> odds board data for the Board screen
router.get("/:sport", async (req, res) => {
  try {
    const sport = req.params.sport;
    const [games, scores] = await Promise.all([
      getOddsForSport(sport),
      getScoresForSport(sport).catch(() => ({})), // scores are a nice-to-have, never block the board
    ]);

    const now = Date.now();
    const enriched = games
      .map((g) => {
        const started = new Date(g.commenceTime).getTime() <= now;
        if (!started) return { ...g, status: "upcoming" };

        const score = scores[g.id];
        if (score && score.completed) {
          return {
            ...g,
            status: "final",
            finalScore: { home: score.homeScore, away: score.awayScore },
          };
        }
        if (score && (score.homeScore !== null || score.awayScore !== null)) {
          return {
            ...g,
            status: "live",
            liveScore: { home: score.homeScore, away: score.awayScore },
          };
        }
        // Started, but we have no score data for it (too old for the scores
        // window, or the provider hasn't posted it yet) — the odds we'd show
        // are stale and possibly misleading, so drop it from the board.
        return null;
      })
      .filter(Boolean);

    res.json({ sport, games: enriched });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Failed to fetch odds", detail: err.message });
  }
});

export default router;
