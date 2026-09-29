import { Router } from "express";
import { getOddsForSport, getScoresForSport, oddsRetrievedAt } from "../services/oddsService.js";
import { getHeadToHead } from "../services/statsService.js";
import { getMatchupInjuries } from "../services/injuryService.js";
import { getGameWeather } from "../services/weatherService.js";
import { getHeadToHeadResults } from "../services/espnService.js";
import { getLineHistory } from "../services/snapshotService.js";
import { VENUES } from "../data/venues.js";
import { toTeamCode } from "../data/teamCodes.js";
import { withTier } from "../middleware/tier.js";
import { meetsTier } from "../services/tierService.js";

const router = Router();

const LINE_MOVEMENT_LOCKED = {
  available: false,
  locked: true,
  reason: "Line movement tracking is an Edge feature.",
  requiredTier: "edge",
};

router.get("/:sport/:gameId", withTier, async (req, res) => {
  const { sport, gameId } = req.params;
  const { season = "2026" } = req.query;

  try {
    const games = await getOddsForSport(sport);
    let game = games.find((g) => g.id === gameId);

    // Not in the live odds feed — likely a game that already finished and
    // dropped off /odds (very common on a busy CFB/CBB slate). Fall back to
    // /scores so the breakdown still opens instead of 404ing on any finished
    // game the Board had to backfill.
    let finalScoreFallback = null;
    if (!game) {
      const scores = await getScoresForSport(sport).catch(() => ({}));
      const s = scores[gameId];
      if (s && s.homeTeam && s.awayTeam) {
        game = {
          id: gameId,
          sport,
          commenceTime: s.commenceTime,
          homeTeam: s.homeTeam,
          awayTeam: s.awayTeam,
          lineTrackingBook: null,
          moneyline: [],
          spread: [],
          total: [],
          allBooks: [],
        };
        if (s.completed) finalScoreFallback = { home: s.homeScore, away: s.awayScore };
      }
    }
    if (!game) return res.status(404).json({ error: "Game not found" });

    const venue = VENUES[game.homeTeam];
    const includeLineMovement = meetsTier(req.userRow, "edge");

    const [injuries, h2h, h2hResults, weather, lineMovement] = await Promise.all([
      // Both teams, each with its own status + freshness metadata. Never a
      // silent empty list on failure — see services/injuryService.js.
      getMatchupInjuries(sport, game.homeTeam, game.awayTeam).catch((err) => {
        console.error(`getMatchupInjuries failed for dossier ${gameId}:`, err.message);
        return null;
      }),
      getHeadToHead(
        sport,
        season,
        toTeamCode(sport, game.homeTeam),
        toTeamCode(sport, game.awayTeam)
      ).catch(() => null),
      ["nfl", "nba", "mlb"].includes(sport)
        ? getHeadToHeadResults(sport, game.homeTeam, game.awayTeam, season).catch((err) => {
            // This used to fail silently — no log line, no visible difference
            // from "genuinely no past meetings." Logging it is what lets us
            // actually diagnose why this section came back empty.
            console.error(`getHeadToHeadResults(${sport}) failed for dossier ${gameId}:`, err.message);
            return [];
          })
        : Promise.resolve([]),
      // A finished game's weather forecast isn't meaningful (and the forecast
      // API generally can't look backward anyway), so skip it entirely.
      finalScoreFallback
        ? Promise.resolve(null)
        : venue && !venue.dome
        ? getGameWeather(venue.lat, venue.lon, game.commenceTime).catch(() => null)
        : Promise.resolve(venue?.dome ? { conditions: "Dome — no weather impact" } : null),
      includeLineMovement
        ? getLineHistory(game.id, game.lineTrackingBook).catch(() => ({
            available: false,
            reason: "Line history lookup failed.",
          }))
        : Promise.resolve(LINE_MOVEMENT_LOCKED),
    ]);

    const now = new Date().toISOString();
    res.json({
      // Short sport slug ("nfl") — game.sport is the odds provider's long key.
      // The chat needs this to re-fetch fresh data for the same game.
      sport,
      game,
      generatedAt: now,
      // Per-section freshness so the UI and the AI can tell live from stale.
      dataFreshness: {
        odds: { source: "The Odds API (consensus of US books)", retrieved_at: oddsRetrievedAt(sport) },
        injuries: {
          home: injuries?.homeTeam ? { source: injuries.homeTeam.source, retrieved_at: injuries.homeTeam.retrieved_at, status: injuries.homeTeam.status } : null,
          away: injuries?.awayTeam ? { source: injuries.awayTeam.source, retrieved_at: injuries.awayTeam.retrieved_at, status: injuries.awayTeam.status } : null,
        },
        weather: weather?.retrieved_at ? { source: weather.source, retrieved_at: weather.retrieved_at } : null,
      },
      finalScore: finalScoreFallback,
      weather,
      // { homeTeam: {...}, awayTeam: {...} } — each with players, status
      // ("ok" | "unavailable"), source, source_url, retrieved_at,
      // published_at, last_updated. `null` only if the whole lookup threw.
      injuries: injuries || {
        homeTeam: { team: game.homeTeam, status: "unavailable", players: [], absenceMeansHealthy: false, note: "Current injury status unavailable." },
        awayTeam: { team: game.awayTeam, status: "unavailable", players: [], absenceMeansHealthy: false, note: "Current injury status unavailable." },
        retrieved_at: null,
      },
      headToHead: h2h || [],
      // Real final scores for past meetings, from ESPN — our stats provider's
      // trial tier doesn't include final scores in its schedule data.
      headToHeadResults: h2hResults || [],
      // Opening vs. current line per market, built from odds snapshots we've
      // recorded over time (see services/snapshotService.js). Not the same as
      // bet%/handle% betting splits — this is actual line movement.
      lineMovement,
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Failed to build dossier", detail: err.message });
  }
});

export default router;
