import { Router } from "express";
import { signup, login, accountsAvailable } from "../services/authService.js";
import { requireAuth } from "../middleware/auth.js";
import { pool } from "../db.js";

const router = Router();

router.get("/status", (_req, res) => {
  res.json({ available: accountsAvailable() });
});

router.post("/signup", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const { user, token } = await signup(email, password);
    res.json({ user, token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const { user, token } = await login(email, password);
    res.json({ user, token });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT id, email, created_at FROM users WHERE id = $1", [
      req.user.id,
    ]);
    if (!rows.length) return res.status(404).json({ error: "User not found." });
    res.json({ user: { id: rows[0].id, email: rows[0].email, createdAt: rows[0].created_at } });
  } catch (err) {
    res.status(500).json({ error: "Failed to load account." });
  }
});

export default router;
