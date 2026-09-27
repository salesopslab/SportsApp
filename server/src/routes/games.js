import { Router } from "express";
import { getOddsForSport, getScoresForSport } from "../services/oddsService.js";

const router = Router();

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

// Best guess at "when a final game actually ended," used to decide whether a
// final game is still within its 24-hour window. Prefers the score
// provider's own last-update timestamp; falls back to kickoff time if that's
// ever missing (better than not showing it at all).
function gameEndTime(commenceTime, lastUpdate) {
  const t = lastUpdate ? new Date(lastUpdate).getTime() : NaN;
  return Number.isNaN(t) ? new Date(commenceTime).getTime() : t;
}

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
        const commence = new Date(g.commenceTime).getTime();
        const started = commence <= now;
        if (!started) {
          // Only show what's coming up in the next 7 days — a book will
          // sometimes post odds on a game weeks out, which isn't useful on
          // a "what's happening soon" board.
          if (commence - now > SEVEN_DAYS_MS) return null;
          return { ...g, status: "upcoming" };
        }

        const score = scores[g.id];
        if (score && score.completed) {
          const endedAt = gameEndTime(g.commenceTime, score.lastUpdate);
          if (now - endedAt > TWENTY_FOUR_HOURS_MS) return null; // finished too long ago
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

    // Sportsbooks often pull a game from /odds the moment it starts (or
    // shortly after) — very common on a busy college football/basketball
    // slate with 40+ games kicking off at once. That means a lot of finished
    // games never show up above at all, even though /scores has their final
    // result. Fill those back in as score-only "final" entries (still capped
    // to the same 24-hour final window) so the board reflects every game
    // that's actually done, not just the ones a book still has posted.
    const seenIds = new Set(enriched.map((g) => g.id));
    const backfilled = Object.entries(scores)
      .filter(([id, s]) => {
        if (seenIds.has(id) || !s.completed || !s.homeTeam || !s.awayTeam) return false;
        const endedAt = gameEndTime(s.commenceTime, s.lastUpdate);
        return now - endedAt <= TWENTY_FOUR_HOURS_MS;
      })
      .map(([id, s]) => ({
        id,
        sport: sport,
        commenceTime: s.commenceTime,
        homeTeam: s.homeTeam,
        awayTeam: s.awayTeam,
        primaryBook: null,
        moneyline: [],
        spread: [],
        total: [],
        allBooks: [],
        status: "final",
        finalScore: { home: s.homeScore, away: s.awayScore },
      }));

    res.json({ sport, games: [...enriched, ...backfilled] });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Failed to fetch odds", detail: err.message });
  }
});

export default router;
