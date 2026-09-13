/**
 * Brain — shared, scoped long-term memory + reflection service.
 *
 * Four-module design (Joshua's model):
 *   OBSERVER  -> POST /write   : capture interactions + their OUTCOME signal
 *   REFLECTOR -> POST /reflect : distill recent trajectories into memory items
 *                                (also runs AUTOMATICALLY on a timer, one scope at a time)
 *   CURATOR   -> (v2)          : merge/rank/prune. v1 seeds it: dedupe on reflect
 *                                bumps confidence, and /recall tracks hit_count/last_used.
 *   TEACHER   -> (v2)          : graduate high-confidence memories into an agent's
 *                                PERMANENT knowledge/system prompt. v1 serves via /standing.
 *
 * WALLED-OFF data: every request carries a `scope` (e.g. "owner:fluid" or
 * "tenant:abc123"). NO query — and NO reflection pass — ever crosses scopes.
 *
 * Env: DATABASE_URL, MEMORY_API_KEY, OPENROUTER_API_KEY, REFLECT_MODEL?,
 *      AUTO_REFLECT? (set "off" to disable), REFLECT_INTERVAL_MIN? (default 180),
 *      REFLECT_MIN_ROWS? (default 3)
 */
const express = require("express");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === "off" ? false : { rejectUnauthorized: false } });
const API_KEY = process.env.MEMORY_API_KEY || "";
const REFLECT_MODEL = process.env.REFLECT_MODEL || "openai/gpt-oss-120b";
const AUTO_REFLECT = process.env.AUTO_REFLECT !== "off";
const REFLECT_INTERVAL_MIN = Math.max(parseInt(process.env.REFLECT_INTERVAL_MIN) || 180, 5);
const REFLECT_MIN_ROWS = Math.max(parseInt(process.env.REFLECT_MIN_ROWS) || 3, 1);

// Normalize typographic punctuation (smart hyphens/dashes/quotes) to plain ASCII so
// keyword recall matches what a human actually types, even when an LLM's reflected
// output uses "smart" characters (e.g. "mini\u2011split" vs "mini-split").
function normText(s) {
  return String(s)
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}


const app = express();
app.use(express.json({ limit: "2mb" }));

// ── Schema (idempotent; shaped for all four modules) ─────────────────────────
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trajectories (
      id BIGSERIAL PRIMARY KEY,
      scope TEXT NOT NULL,
      session_id TEXT,
      ts TIMESTAMPTZ DEFAULT now(),
      role TEXT,
      content TEXT,
      signal TEXT,                       -- OBSERVER: outcome tag (success|fail|correction|win|note)
      reflected BOOLEAN DEFAULT false
    );
    CREATE INDEX IF NOT EXISTS idx_traj_scope ON trajectories(scope, reflected);
    CREATE TABLE IF NOT EXISTS memories (
      id BIGSERIAL PRIMARY KEY,
      scope TEXT NOT NULL,
      type TEXT,                         -- fact | playbook | preference | mistake
      content TEXT NOT NULL,
      trigger TEXT,
      hit_count INTEGER DEFAULT 0,       -- CURATOR: how often recalled
      confidence REAL DEFAULT 0.5,       -- CURATOR: bumped when a lesson re-surfaces
      last_used TIMESTAMPTZ,             -- CURATOR: recency of actual use
      graduated BOOLEAN DEFAULT false,   -- TEACHER: promoted to permanent knowledge
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

app.get("/health", (_req, res) => res.json({ ok: true, service: "brain", autoReflect: AUTO_REFLECT }));

// ── OBSERVER: log a raw interaction (+ optional outcome signal) ──────────────
app.post("/write", async (req, res) => {
  const scope = getScope(req);
  if (!scope) return res.status(400).json({ error: "valid scope required" });
  const { session_id = "", role = "user", content = "", signal = null } = req.body || {};
  if (!content) return res.status(400).json({ error: "content required" });
  await pool.query("INSERT INTO trajectories(scope, session_id, role, content, signal) VALUES ($1,$2,$3,$4,$5)",
    [scope, String(session_id).slice(0, 200), String(role).slice(0, 40), String(content).slice(0, 20000), signal ? String(signal).slice(0, 40) : null]);
  res.json({ ok: true });
});

// ── TEACHER (passive v1): the always-on memory block for a scope ─────────────
app.get("/standing", async (req, res) => {
  const scope = getScope(req);
  if (!scope) return res.status(400).json({ error: "valid scope required" });
  const { rows } = await pool.query(
    "SELECT type, content, trigger FROM memories WHERE scope=$1 ORDER BY confidence DESC, updated_at DESC LIMIT 120", [scope]);
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

// ── CURATOR (seed): keyword recall + track hit_count/last_used ───────────────
app.get("/recall", async (req, res) => {
  const scope = getScope(req);
  if (!scope) return res.status(400).json({ error: "valid scope required" });
  const q = normText(String(req.query.q || "").trim());
  const limit = Math.min(parseInt(req.query.limit) || 8, 30);
  let rows;
  if (q) {
    ({ rows } = await pool.query(
      "SELECT id, type, content, trigger FROM memories WHERE scope=$1 AND (content ILIKE $2 OR trigger ILIKE $2) ORDER BY confidence DESC, updated_at DESC LIMIT $3",
      [scope, `%${q.slice(0, 100)}%`, limit]));
  } else {
    ({ rows } = await pool.query("SELECT id, type, content, trigger FROM memories WHERE scope=$1 ORDER BY updated_at DESC LIMIT $2", [scope, limit]));
  }
  if (rows.length) await pool.query("UPDATE memories SET hit_count = hit_count + 1, last_used = now() WHERE id = ANY($1)", [rows.map(r => r.id)]);
  res.json({ items: rows.map(({ type, content, trigger }) => ({ type, content, trigger })) });
});

// ── REFLECTOR core ───────────────────────────────────────────────────────────
const REFLECT_SYS = `You are the reflection engine for an AI agent's long-term memory. You are given recent raw interactions for ONE scope, each optionally tagged with an outcome signal. Extract only DURABLE, reusable memory worth recalling next time.
Rules:
- Capture: facts, reusable playbooks/how-tos, the owner's preferences, and mistakes to avoid.
- Weight lessons by outcome: things that led to success or a correction matter most.
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

// Reflect exactly ONE scope. Shared by POST /reflect and the auto-reflect timer.
// Every query is locked to a single scope — isolation cannot leak here.
async function reflectScope(scope, limit = 60) {
  const { rows: traj } = await pool.query(
    "SELECT id, role, content, signal FROM trajectories WHERE scope=$1 AND reflected=false ORDER BY id ASC LIMIT $2", [scope, limit]);
  if (!traj.length) return { added: 0, reinforced: 0, reflected_rows: 0, note: "nothing new" };
  const text = traj.map(t => `${t.role}${t.signal ? ` [${t.signal}]` : ""}: ${t.content}`).join("\n").slice(-14000);
  const items = await llmReflect(text);
  let added = 0, reinforced = 0;
  for (const it of (Array.isArray(items) ? items : [])) {
    const content = normText(String(it?.content || "").trim()); if (!content) continue;
    const type = ["fact", "playbook", "preference", "mistake"].includes(it?.type) ? it.type : "fact";
    const trigger = normText(String(it?.trigger || "").slice(0, 300));
    const dup = await pool.query("SELECT id FROM memories WHERE scope=$1 AND content=$2 LIMIT 1", [scope, content.slice(0, 2000)]);
    if (dup.rowCount) {
      // early CURATOR: reinforce instead of duplicate.
      await pool.query("UPDATE memories SET confidence = LEAST(confidence + 0.1, 1.0), hit_count = hit_count + 1, updated_at = now() WHERE id=$1", [dup.rows[0].id]);
      reinforced++; continue;
    }
    await pool.query("INSERT INTO memories(scope, type, content, trigger) VALUES ($1,$2,$3,$4)", [scope, type, content.slice(0, 2000), trigger]);
    added++;
  }
  await pool.query("UPDATE trajectories SET reflected=true WHERE id = ANY($1)", [traj.map(t => t.id)]);
  return { added, reinforced, reflected_rows: traj.length, items };
}

app.post("/reflect", async (req, res) => {
  const scope = getScope(req);
  if (!scope) return res.status(400).json({ error: "valid scope required" });
  const limit = Math.min(parseInt(req.body?.limit) || 60, 200);
  try {
    const out = await reflectScope(scope, limit);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(502).json({ error: "reflect failed: " + e.message });
  }
});

// ── AUTO-REFLECTOR: on a timer, reflect every scope with enough new rows,
//    ONE SCOPE AT A TIME (never batch scopes together — that's the only place
//    cross-tenant bleed could happen). Guarded so ticks never overlap. ─────────
let reflecting = false;
async function autoReflectTick() {
  if (reflecting) return;
  reflecting = true;
  try {
    const { rows } = await pool.query(
      `SELECT scope, COUNT(*)::int AS n FROM trajectories WHERE reflected=false GROUP BY scope HAVING COUNT(*) >= $1 ORDER BY n DESC`,
      [REFLECT_MIN_ROWS]);
    for (const { scope, n } of rows) {
      try {
        const out = await reflectScope(scope);
        console.log(`[brain] auto-reflect ${scope}: +${out.added} new, ${out.reinforced} reinforced (${n} rows)`);
      } catch (e) {
        console.error(`[brain] auto-reflect ${scope} failed:`, e.message);
      }
    }
  } catch (e) {
    console.error("[brain] auto-reflect tick failed:", e.message);
  } finally {
    reflecting = false;
  }
}


// ── BRAIN SOCKET ─────────────────────────────────────────────────────────────
// One reasoning endpoint any caller (a Telnyx bot, Telegram, a website widget)
// can ask a question instead of carrying the whole business brain itself.
// The model underneath is a one-variable swap (RESPOND_MODEL) via OpenRouter.
// Nothing calls this yet on purpose - it is proven standalone first.
//
// TOOLS below are MOSTLY STUBS during this build-out. get_business_info and
// check_service_capability are real (they read this service's own memory
// table). Everything else honestly reports {stub:true} rather than pretending
// to be wired to a real CRM/calendar/SMS provider that does not exist yet.
const TOOLS = {
  async get_business_info({ scope }) {
    const { rows } = await pool.query(
      "SELECT type, content, trigger FROM memories WHERE scope=$1 ORDER BY confidence DESC, updated_at DESC LIMIT 120", [scope]);
    return { count: rows.length, memories: rows };
  },
  async check_service_capability({ scope, query: q }) {
    const term = normText(String(q || "").trim());
    if (!term) return { matched: false, items: [] };
    const { rows } = await pool.query(
      "SELECT type, content, trigger FROM memories WHERE scope=$1 AND (content ILIKE $2 OR trigger ILIKE $2) ORDER BY confidence DESC LIMIT 5",
      [scope, `%${term.slice(0, 100)}%`]);
    return { matched: rows.length > 0, items: rows };
  },
  async check_service_area() { return { stub: true, note: "not wired to real service-area data yet" }; },
  async get_pricing() { return { stub: true, note: "not wired to real pricing data yet" }; },
  async check_calendar() { return { stub: true, note: "not wired to a real calendar yet" }; },
  async book_appointment() { return { stub: true, note: "not wired to a real calendar yet" }; },
  async create_lead() { return { stub: true, note: "not wired to a real CRM yet" }; },
  async update_lead() { return { stub: true, note: "not wired to a real CRM yet" }; },
  async notify_owner() { return { stub: true, note: "not wired to a real notification channel yet" }; },
  async send_sms() { return { stub: true, note: "not wired to a real SMS provider yet" }; },
  async handoff_to_human() { return { stub: true, note: "not wired to a real handoff mechanism yet" }; },
};
const TOOL_LIST = Object.keys(TOOLS);
const RESPOND_MODEL = process.env.RESPOND_MODEL || REFLECT_MODEL;

const RESPOND_SYS = (standingBlock) => `You are the Contractor Brain for one specific contractor. Answer the incoming message directly and briefly, the way a sharp office manager would.
You have this business's known memory below - treat it as ground truth, do not contradict it:
${standingBlock || "(no memory recorded yet for this contractor)"}

You have tools you may call when you need information you do not already have. Available tools: ${TOOL_LIST.join(", ")}.
Most of these tools are STUBS during this build-out and will say so in their result - if a tool result has "stub": true, tell the truth: say you do not have that wired up yet rather than making something up.

HARD RULE: you have NO phone number, address, price, or contact detail of any kind unless it appears verbatim in the memory block above or in a tool result. Do not output any phone number, address, or price under any circumstances unless it is copied verbatim from memory or a tool result. If a customer asks to book or asks for contact info and you cannot do it yourself (a tool result says stub:true, or you have no tool for it), say exactly this kind of thing: "I cannot book that myself yet - someone from the team will follow up with you directly." Never invent a callback number or address to fill that gap.
To call a tool, end your reply with a line of the exact form:
ACTION: {"tool":"tool_name","args":{...}}
Only call a tool when you actually need it. If you do not need a tool, just answer.`;

// A hard, code-level backstop: no model can be fully talked out of inventing a
// phone number via prompt alone (555-xxxx is the universal fake-number reflex
// across every model tested). Strip any phone-shaped string the model outputs
// unless it is verbatim in the contractor's own standing memory.
const PHONE_RE = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
function stripUnverifiedPhoneNumbers(text, standingBlock) {
  return String(text).replace(PHONE_RE, (m) => (standingBlock && standingBlock.includes(m)) ? m : "[no verified callback number on file]");
}

function parseAction(raw) {
  const idx = raw.indexOf("ACTION:");
  if (idx === -1) return { text: raw.trim(), action: null };
  const text = raw.slice(0, idx).trim();
  const tail = raw.slice(idx + 7).trim();
  const m = tail.match(/\{[\s\S]*\}/);
  if (!m) return { text, action: null };
  try {
    const parsed = JSON.parse(m[0]);
    if (parsed && typeof parsed.tool === "string") return { text, action: parsed };
  } catch {}
  return { text, action: null };
}

async function callModel(messages) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: RESPOND_MODEL, temperature: 0.3, max_tokens: 500, messages }),
    signal: AbortSignal.timeout(30000),
  });
  const d = await r.json();
  if (d?.error) throw new Error(typeof d.error === "string" ? d.error : JSON.stringify(d.error));
  return d?.choices?.[0]?.message?.content || "";
}

app.post("/v1/brain/respond", async (req, res) => {
  const scope = getScope(req);
  if (!scope) return res.status(400).json({ error: "valid scope required" });
  const { message = "", conversation_id = "" } = req.body || {};
  if (!message) return res.status(400).json({ error: "message required" });
  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(503).json({ error: "no model configured - set OPENROUTER_API_KEY", response: null, action: null, handoff: true });
  }
  try {
    await pool.query("INSERT INTO trajectories(scope, session_id, role, content) VALUES ($1,$2,'user',$3)",
      [scope, String(conversation_id).slice(0, 200), String(message).slice(0, 20000)]);

    const { rows } = await pool.query(
      "SELECT type, content, trigger FROM memories WHERE scope=$1 ORDER BY confidence DESC, updated_at DESC LIMIT 120", [scope]);
    const byType = {};
    for (const r of rows) (byType[r.type] = byType[r.type] || []).push(r);
    const order = ["preference", "fact", "playbook", "mistake"];
    const label = { preference: "PREFERENCES", fact: "FACTS", playbook: "PLAYBOOKS", mistake: "MISTAKES TO AVOID" };
    let standingBlock = "";
    for (const t of order) if (byType[t]?.length) {
      standingBlock += `\n${label[t]}:\n` + byType[t].map(r => `- ${r.content}${r.trigger ? ` (when: ${r.trigger})` : ""}`).join("\n") + "\n";
    }

    const messages = [
      { role: "system", content: RESPOND_SYS(standingBlock.trim()) },
      { role: "user", content: String(message).slice(0, 4000) },
    ];

    let raw = await callModel(messages);
    let { text, action } = parseAction(raw);
    text = stripUnverifiedPhoneNumbers(text, standingBlock);
    let toolResult = null;

    if (action && TOOLS[action.tool]) {
      toolResult = await TOOLS[action.tool]({ scope, ...(action.args || {}) });
      messages.push({ role: "assistant", content: raw });
      messages.push({ role: "user", content: `TOOL RESULT for ${action.tool}: ${JSON.stringify(toolResult)}\n\nNow give the final answer, plain text, no ACTION line.` });
      raw = await callModel(messages);
      text = stripUnverifiedPhoneNumbers(raw.trim(), standingBlock);
    } else if (action) {
      toolResult = { error: `unknown tool "${action.tool}"` };
    }

    await pool.query("INSERT INTO trajectories(scope, session_id, role, content) VALUES ($1,$2,'assistant',$3)",
      [scope, String(conversation_id).slice(0, 200), text.slice(0, 20000)]);

    res.json({ response: text, action: action ? action.tool : null, tool_result: toolResult, handoff: false });
  } catch (e) {
    res.status(502).json({ error: "brain respond failed: " + e.message, response: null, action: null, handoff: true });
  }
});

const PORT = process.env.PORT || 8080;
initDb().then(() => {
  app.listen(PORT, () => console.log(`[brain] listening on ${PORT}`));
  if (AUTO_REFLECT) {
    console.log(`[brain] auto-reflect ON — every ${REFLECT_INTERVAL_MIN} min, scopes with >= ${REFLECT_MIN_ROWS} new rows`);
    setTimeout(autoReflectTick, 90_000); // first pass ~90s after boot
    setInterval(autoReflectTick, REFLECT_INTERVAL_MIN * 60_000);
  }
}).catch((e) => { console.error("[brain] DB init failed:", e.message); process.exit(1); });
