/**
 * Brain — shared, scoped long-term memory + reflection service.
 *
 * One engine, many callers, WALLED-OFF data. Every request carries a `scope`
 * (e.g. "owner:fluid" or "tenant:abc123") and NO query ever crosses scopes.
 *
 * Routes (all require Authorization: Bearer <MEMORY_API_KEY>):
 *   GET  /health
 *   POST /write     { scope, session_id?, role?, content }        -> log raw interaction
 *   GET  /standing?scope=                                          -> the always-on memory block
 *   GET  /recall?scope=&q=&limit=                                  -> relevant memories (keyword v1)
 *   POST /reflect   { scope, limit? }                              -> distill recent trajectories into memories
 *
 * Env: DATABASE_URL, MEMORY_API_KEY, OPENROUTER_API_KEY, REFLECT_MODEL?
 */
const express = require("express");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === "off" ? false : { rejectUnauthorized: false } });
const API_KEY = process.env.MEMORY_API_KEY || "";
const REFLECT_MODEL = process.env.REFLECT_MODEL || "openai/gpt-oss-120b";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ── Schema (idempotent) ──────────────────────────────────────────────────────
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trajectories (
      id BIGSERIAL PRIMARY KEY,
      scope TEXT NOT NULL,
      session_id TEXT,
      ts TIMESTAMPTZ DEFAULT now(),
      role TEXT,
      content TEXT,
      reflected BOOLEAN DEFAULT false
    );
    CREATE INDEX IF NOT EXISTS idx_traj_scope ON trajectories(scope, reflected);
    CREATE TABLE IF NOT EXISTS memories (
      id BIGSERIAL PRIMARY KEY,
      scope TEXT NOT NULL,
      type TEXT,
      content TEXT NOT NULL,
      trigger TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_mem_scope ON memories(scope);
  `);
}

// ── Auth + scope guards ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const tok = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!API_KEY || tok !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
});
function getScope(req) {
  const s = String(req.body?.scope ?? req.query?.scope ?? "").trim();
  return /^[a-zA-Z0-9:_\-]{1,120}$/.test(s) ? s : "";
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "brain" }));

// ── WRITE: log a raw interaction ─────────────────────────────────────────────
app.post("/write", async (req, res) => {
  const scope = getScope(req);
  if (!scope) return res.status(400).json({ error: "valid scope required" });
  const { session_id = "", role = "user", content = "" } = req.body || {};
  if (!content) return res.status(400).json({ error: "content required" });
  await pool.query("INSERT INTO trajectories(scope, session_id, role, content) VALUES ($1,$2,$3,$4)",
    [scope, String(session_id).slice(0, 200), String(role).slice(0, 40), String(content).slice(0, 20000)]);
  res.json({ ok: true });
});

// ── STANDING: the always-on memory block for a scope ─────────────────────────
app.get("/standing", async (req, res) => {
  const scope = getScope(req);
  if (!scope) return res.status(400).json({ error: "valid scope required" });
  const { rows } = await pool.query(
    "SELECT type, content, trigger FROM memories WHERE scope=$1 ORDER BY type, updated_at DESC LIMIT 120", [scope]);
  const byType = {};
  for (const r of rows) (byType[r.type] = byType[r.type] || []).push(r);
  const order = ["preference", "fact", "playbook", "mistake"];
  const label = { preference: "PREFERENCES", fact: "FACTS", playbook: "PLAYBOOKS", mistake: "MISTAKES TO AVOID" };
  let block = "";
  for (const t of order) if (byType[t]?.length) {
    block += `\n${label[t] || t.toUpperCase()}:\n` + byType[t].map(r => `- ${r.content}${r.trigger ? ` (when: ${r.trigger})` : ""}`).join("\n") + "\n";
  }
  res.json({ block: block.trim(), count: rows.length });
});

// ── RECALL: keyword-relevant memories (v1) ───────────────────────────────────
app.get("/recall", async (req, res) => {
  const scope = getScope(req);
  if (!scope) return res.status(400).json({ error: "valid scope required" });
  const q = String(req.query.q || "").trim();
  const limit = Math.min(parseInt(req.query.limit) || 8, 30);
  let rows;
  if (q) {
    ({ rows } = await pool.query(
      "SELECT type, content, trigger FROM memories WHERE scope=$1 AND (content ILIKE $2 OR trigger ILIKE $2) ORDER BY updated_at DESC LIMIT $3",
      [scope, `%${q.slice(0, 100)}%`, limit]));
  } else {
    ({ rows } = await pool.query("SELECT type, content, trigger FROM memories WHERE scope=$1 ORDER BY updated_at DESC LIMIT $2", [scope, limit]));
  }
  res.json({ items: rows });
});

// ── REFLECT: distill recent trajectories into memories (one scope only) ──────
const REFLECT_SYS = `You are the reflection engine for an AI agent's long-term memory. You are given recent raw interactions for ONE scope. Extract only DURABLE, reusable memory worth recalling next time.
Rules:
- Capture: facts, reusable playbooks/how-tos, the owner's preferences, and mistakes to avoid.
- Be SPECIFIC and tie each to a TRIGGER (when it applies). No vague advice like "be better".
- Skip one-off trivia and anything obvious.
- Output ONLY a JSON array. Each item: {"type":"fact|playbook|preference|mistake","content":"specific lesson","trigger":"when it applies"}
- If nothing is worth saving, output [].`;

async function llmReflect(text) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: REFLECT_MODEL, temperature: 0.2, max_tokens: 1200,
      messages: [{ role: "system", content: REFLECT_SYS }, { role: "user", content: "RECENT INTERACTIONS:\n\n" + text }] }),
    signal: AbortSignal.timeout(60000),
  });
  const d = await r.json();
  const raw = d?.choices?.[0]?.message?.content || "[]";
  const m = raw.match(/\[[\s\S]*\]/);
  try { return JSON.parse(m ? m[0] : raw); } catch { return []; }
}

app.post("/reflect", async (req, res) => {
  const scope = getScope(req);
  if (!scope) return res.status(400).json({ error: "valid scope required" });
  const limit = Math.min(parseInt(req.body?.limit) || 60, 200);
  const { rows: traj } = await pool.query(
    "SELECT id, role, content FROM trajectories WHERE scope=$1 AND reflected=false ORDER BY id ASC LIMIT $2", [scope, limit]);
  if (!traj.length) return res.json({ ok: true, added: 0, note: "nothing new to reflect on" });
  // Compact: keep it under a rough budget (protect nothing fancy for v1 — just cap size).
  let text = traj.map(t => `${t.role}: ${t.content}`).join("\n").slice(-14000);
  let items = [];
  try { items = await llmReflect(text); } catch (e) { return res.status(502).json({ error: "reflect LLM failed: " + e.message }); }
  let added = 0;
  for (const it of (Array.isArray(items) ? items : [])) {
    const content = String(it?.content || "").trim(); if (!content) continue;
    const type = ["fact", "playbook", "preference", "mistake"].includes(it?.type) ? it.type : "fact";
    const trigger = String(it?.trigger || "").slice(0, 300);
    const dup = await pool.query("SELECT 1 FROM memories WHERE scope=$1 AND content=$2 LIMIT 1", [scope, content.slice(0, 2000)]);
    if (dup.rowCount) continue;
    await pool.query("INSERT INTO memories(scope, type, content, trigger) VALUES ($1,$2,$3,$4)", [scope, type, content.slice(0, 2000), trigger]);
    added++;
  }
  await pool.query("UPDATE trajectories SET reflected=true WHERE id = ANY($1)", [traj.map(t => t.id)]);
  res.json({ ok: true, reflected_rows: traj.length, added, items });
});

const PORT = process.env.PORT || 8080;
initDb().then(() => app.listen(PORT, () => console.log(`[brain] listening on ${PORT}`)))
  .catch((e) => { console.error("[brain] DB init failed:", e.message); process.exit(1); });
