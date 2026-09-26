import { Router } from "express";
import { getOddsForSport } from "../services/oddsService.js";

const router = Router();

// GET /api/games/:sport  -> odds board data for the Board screen
router.get("/:sport", async (req, res) => {
  try {
    const games = await getOddsForSport(req.params.sport);
    res.json({ sport: req.params.sport, games });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Failed to fetch odds", detail: err.message });
  }
});

export default router;
