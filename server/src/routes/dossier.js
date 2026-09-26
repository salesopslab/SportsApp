import { Router } from "express";
import { getOddsForSport } from "../services/oddsService.js";
import { getInjuries, getHeadToHead } from "../services/statsService.js";
import { getGameWeather } from "../services/weatherService.js";
import { VENUES } from "../data/venues.js";

const router = Router();

// GET /api/dossier/:sport/:gameId -> everything the Dossier screen and AI chat need for one game
router.get("/:sport/:gameId", async (req, res) => {
  const { sport, gameId } = req.params;
  const { season = "2026", week = "1" } = req.query;

  try {
    const games = await getOddsForSport(sport);
    const game = games.find((g) => g.id === gameId);
    if (!game) return res.status(404).json({ error: "Game not found" });

    const venue = VENUES[game.homeTeam];

    // Run independent lookups in parallel — no reason to wait on each in sequence.
    const [injuries, homeSchedule, weather] = await Promise.all([
      getInjuries(sport, season, week).catch(() => null),
      getHeadToHead(sport, season, game.homeTeam).catch(() => null),
      venue && !venue.dome
        ? getGameWeather(venue.lat, venue.lon, game.commenceTime).catch(() => null)
        : Promise.resolve(venue?.dome ? { conditions: "Dome — no weather impact" } : null),
    ]);

    const h2h = (homeSchedule || []).filter(
      (g) => g.Opponent === game.awayTeam || g.HomeTeam === game.awayTeam
    );

    res.json({
      game,
      weather,
      injuries: (injuries || []).filter(
        (i) => i.Team === game.homeTeam || i.Team === game.awayTeam
      ),
      headToHead: h2h,
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Failed to build dossier", detail: err.message });
  }
});

export default router;
