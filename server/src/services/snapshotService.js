import { pool, ensureSchema } from "../db.js";

/**
 * Persist a snapshot of every book's current line for a batch of games, so we
 * can show real line movement over time (e.g. "opened -3, now -3.5"). This is
 * a no-op if no DATABASE_URL is configured — it never blocks or breaks the
 * odds response either way.
 *
 * Only called when oddsService actually fetches fresh data from the provider
 * (a cache miss), so in practice a snapshot lands roughly every
 * CACHE_TTL_SECONDS while there's real traffic on the app.
 */
export async function recordSnapshot(sportSlug, games) {
  if (!pool) return;
  try {
    await ensureSchema();

    const rows = [];
    for (const game of games) {
      for (const b of game.allBooks || []) {
        for (const o of b.moneyline || []) {
          rows.push([sportSlug, game.id, b.book, "moneyline", o.name, null, o.price]);
        }
        for (const o of b.spread || []) {
          rows.push([sportSlug, game.id, b.book, "spread", o.name, o.point ?? null, o.price]);
        }
        for (const o of b.total || []) {
          rows.push([sportSlug, game.id, b.book, "total", o.name, o.point ?? null, o.price]);
        }
      }
    }
    if (!rows.length) return;

    const values = [];
    const placeholders = rows
      .map((r, i) => {
        const base = i * 7;
        values.push(...r);
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`;
      })
      .join(",");

    await pool.query(
      `INSERT INTO odds_snapshots (sport, game_id, book, market, side, point, price) VALUES ${placeholders}`,
      values
    );
  } catch (err) {
    // Never let history recording break the actual odds/dossier response.
    console.error("recordSnapshot failed:", err.message);
  }
}

/**
 * Returns line-movement history for one game: per market/side, the earliest
 * ("opening") value we've recorded vs. the most recent ("current") one.
 * Prefers the primary book's own history (apples-to-apples comparison);
 * falls back to whatever book has data if the primary book doesn't yet.
 */
export async function getLineHistory(gameId, primaryBook) {
  if (!pool) {
    return {
      available: false,
      reason:
        "No database connected yet — line-movement tracking needs a DATABASE_URL configured.",
    };
  }

  try {
    await ensureSchema();
    const { rows } = await pool.query(
      `SELECT book, market, side, point, price, captured_at
       FROM odds_snapshots
       WHERE game_id = $1
       ORDER BY captured_at ASC`,
      [gameId]
    );

    if (!rows.length) {
      return {
        available: true,
        hasHistory: false,
        note: "No snapshots recorded for this game yet — check back after the odds refresh a few times.",
      };
    }

    const bookRows = primaryBook ? rows.filter((r) => r.book === primaryBook) : rows;
    const useRows = bookRows.length ? bookRows : rows;
    const bookUsed = bookRows.length ? primaryBook : useRows[0].book;

    const groups = {};
    for (const r of useRows) {
      const key = `${r.market}:${r.side || ""}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(r);
    }

    const summary = Object.entries(groups).map(([key, pts]) => {
      const [market, side] = key.split(":");
      const open = pts[0];
      const current = pts[pts.length - 1];
      const pointNum = (v) => (v === null || v === undefined ? null : Number(v));
      return {
        market,
        side: side || null,
        openPoint: pointNum(open.point),
        openPrice: open.price,
        currentPoint: pointNum(current.point),
        currentPrice: current.price,
        moved: String(open.point) !== String(current.point) || open.price !== current.price,
        firstSeen: open.captured_at,
        lastSeen: current.captured_at,
        dataPoints: pts.length,
      };
    });

    return { available: true, hasHistory: true, book: bookUsed, summary };
  } catch (err) {
    console.error("getLineHistory failed:", err.message);
    return { available: false, reason: "Line history lookup failed." };
  }
}
