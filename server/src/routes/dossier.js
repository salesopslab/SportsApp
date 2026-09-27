import { Router } from "express";
import { getOddsForSport } from "../services/oddsService.js";
import { getInjuries, getHeadToHead } from "../services/statsService.js";
import { getGameWeather } from "../services/weatherService.js";
import { getHeadToHeadResults } from "../services/espnService.js";
import { getLineHistory } from "../services/snapshotService.js";
import { VENUES } from "../data/venues.js";
import { toTeamCode } from "../data/teamCodes.js";

const router = Router();

router.get("/:sport/:gameId", async (req, res) => {
  const { sport, gameId } = req.params;
  const { season = "2026" } = req.query;

  try {
    const games = await getOddsForSport(sport);
    const game = games.find((g) => g.id === gameId);
    if (!game) return res.status(404).json({ error: "Game not found" });

    const venue = VENUES[game.homeTeam];

    const [injuries, h2h, h2hResults, weather, lineMovement] = await Promise.all([
      getInjuries(sport).catch(() => null),
      getHeadToHead(
        sport,
        season,
        toTeamCode(sport, game.homeTeam),
        toTeamCode(sport, game.awayTeam)
      ).catch(() => null),
      sport === "nfl"
        ? getHeadToHeadResults(game.homeTeam, game.awayTeam, season).catch(() => [])
        : Promise.resolve([]),
      venue && !venue.dome
        ? getGameWeather(venue.lat, venue.lon, game.commenceTime).catch(() => null)
        : Promise.resolve(venue?.dome ? { conditions: "Dome — no weather impact" } : null),
      getLineHistory(game.id, game.primaryBook).catch(() => ({
        available: false,
        reason: "Line history lookup failed.",
      })),
    ]);

    res.json({
      game,
      weather,
      injuries: (injuries || []).filter(
        (i) =>
          i.Team === toTeamCode(sport, game.homeTeam) ||
          i.Team === toTeamCode(sport, game.awayTeam)
      ),
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
