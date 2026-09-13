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
const nodePath = require("path");
const { Pool } = require("pg");

// connectionTimeoutMillis matters more than it looks: without it, a single
// slow/flaky connect attempt (seen live: 2+ minutes over Railway's internal
// network) hangs that long before failing, instead of failing fast so a
// retry or a healthcheck gets a quick, honest answer either way.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === "off" ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 5000 });
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
    CREATE TABLE IF NOT EXISTS module_activations (
      scope TEXT NOT NULL,
      module TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'inactive',   -- 'active' | 'inactive'
      activated_at TIMESTAMPTZ,
      deactivated_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (scope, module)
    );
    CREATE TABLE IF NOT EXISTS usage_events (
      id BIGSERIAL PRIMARY KEY,
      scope TEXT NOT NULL,
      module TEXT NOT NULL,
      event_type TEXT NOT NULL,        -- 'invoked' | 'success' | 'error'
      detail TEXT,
      duration_ms INTEGER,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_usage_scope_module ON usage_events(scope, module, created_at);
    ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS tokens_in INTEGER;
    ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS tokens_out INTEGER;
    ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(12,6);

  `);
}

// ── CORS: lets a browser-based admin dashboard call this API directly. This is
// NOT the security boundary - the Bearer token below is. CORS just decides
// whether a browser will let a page from another origin make the call at all.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Admin dashboard: served as a plain static page from this same origin, not
// a claude.ai Artifact (Artifacts can't fetch arbitrary external hosts).
// Explicit routes, not express.static's directory-index behaviour - the file
// is admin.html, not index.html, so a bare static mount 404s/falls through
// to the auth check on the trailing-slash redirect.
app.get(["/admin", "/admin/"], (req, res) => {
  res.sendFile(nodePath.join(__dirname, "public", "admin.html"));
});

// ── Auth + scope guards ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === "/health" || req.path === "/monitor/status") return next();
  const tok = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!API_KEY || tok !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
});
function getScope(req) {
  const s = String(req.body?.scope ?? req.query?.scope ?? "").trim();
  return /^[a-zA-Z0-9:_\-]{1,120}$/.test(s) ? s : "";
}

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "brain", autoReflect: AUTO_REFLECT, db: "up" });
  } catch (e) {
    res.status(503).json({ ok: false, service: "brain", db: "down", error: e.message });
  }
});

// ── MONITORING: one endpoint an external check can poll to know if anything
// actually needs a human. Silent (problems: []) when nothing does - this is
// meant to be read by a scheduled check, not a person, most of the time.
app.get("/monitor/status", async (_req, res) => {
  const problems = [];
  let dbOk = true;
  try {
    await pool.query("SELECT 1");
  } catch (e) {
    dbOk = false;
    problems.push(`database unreachable: ${e.message}`);
  }
  let errorCount = 0, negativeMargins = [];
  if (dbOk) {
    try {
      const { rows: errRows } = await pool.query(
        "SELECT COUNT(*) AS n FROM usage_events WHERE event_type='error' AND created_at > now() - interval '1 hour'");
      errorCount = Number(errRows[0].n);
      if (errorCount > 0) problems.push(`${errorCount} logged error event(s) in the last hour`);
    } catch (e) { problems.push(`could not check recent errors: ${e.message}`); }
    try {
      const month = new Date().toISOString().slice(0, 7);
      const { rows: marginRows } = await pool.query(
        `SELECT scope, module, COALESCE(SUM(cost_usd),0) AS cost_usd
         FROM usage_events WHERE event_type='ai_call' AND to_char(created_at,'YYYY-MM')=$1
         GROUP BY scope, module`, [month]);
      for (const r of marginRows) {
        const price = MODULE_PRICE_USD[r.module];
        if (price != null && Number(r.cost_usd) > price) {
          negativeMargins.push({ scope: r.scope, module: r.module, cost_usd: Number(r.cost_usd), price_usd: price });
        }
      }
      if (negativeMargins.length) problems.push(`${negativeMargins.length} scope(s) running negative margin this month`);
    } catch (e) { problems.push(`could not check margins: ${e.message}`); }
  }
  res.json({ ok: problems.length === 0, db: dbOk ? "up" : "down", error_count_1h: errorCount, negative_margin_count: negativeMargins.length, problems });
});

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
  // Only ever reflect what a human said. Reflecting the assistant's OWN prior
  // answers into memory creates a feedback loop where one hallucination gets
  // written down as a permanent "fact" or "playbook" and repeats forever -
  // found live during testing (a fake phone number got promoted to a memorized
  // playbook this exact way). Assistant turns still get logged for audit, they
  // just never become something the brain treats as ground truth about itself.
  const { rows: traj } = await pool.query(
    "SELECT id, role, content, signal FROM trajectories WHERE scope=$1 AND reflected=false AND role != 'assistant' ORDER BY id ASC LIMIT $2", [scope, limit]);
  // still mark any not-yet-reflected assistant rows as reflected so they do not
  // pile up forever waiting for a reflect pass that will never use them
  await pool.query("UPDATE trajectories SET reflected=true WHERE scope=$1 AND reflected=false AND role='assistant'", [scope]);
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
// TOOL LIBRARY - progressive disclosure, same idea as how Claude Code's own
// tools work (most are "deferred" until searched for by name). Only tools
// flagged `always: true` are described to the model on the first turn. Any
// other tool must be discovered first via find_tools({query}) before the
// model can call it - the full list is never dumped into every prompt.
// get_business_info, check_service_capability and get_pricing are REAL (they
// read this service's own memory table). Everything else honestly reports
// {stub:true} rather than pretending to be wired to a real CRM/calendar/SMS
// provider that does not exist yet.
const TOOL_LIBRARY = {
  find_tools: {
    always: true,
    description: "Search for tools relevant to what you need right now. Pass {\"query\": \"plain words\"} describing the task (e.g. \"book an appointment\", \"what we charge\"). Returns matching tool names + descriptions you can then call directly.",
    keywords: [],
    async run({ query }) {
      const q = normText(String(query || "").toLowerCase());
      const all = Object.entries(TOOL_LIBRARY).filter(([, t]) => !t.always);
      let hits = all.filter(([name, t]) => !q || name.toLowerCase().includes(q) || (t.keywords || []).some(k => q.includes(k) || k.includes(q)));
      if (!hits.length) hits = all; // library is small right now - don't dead-end the model on a miss
      return { matches: hits.map(([name, t]) => ({ tool: name, description: t.description })) };
    },
  },
  handoff_to_human: {
    always: true,
    description: "Use when you cannot help with something yourself - the universal fallback. No args needed.",
    keywords: ["human", "help", "escalate", "manager", "someone else"],
    async run() { return { stub: true, note: "not wired to a real handoff mechanism yet - tell the customer someone from the team will follow up" }; },
  },
  get_business_info: {
    description: "Pull everything remembered about this business - facts, playbooks, preferences. Rarely needed since the standing memory in your system prompt already has the top items.",
    keywords: ["business", "info", "memory", "know", "remember"],
    async run({ scope }) {
      const { rows } = await pool.query(
        "SELECT type, content, trigger FROM memories WHERE scope=$1 ORDER BY confidence DESC, updated_at DESC LIMIT 120", [scope]);
      return { count: rows.length, memories: rows };
    },
  },
  check_service_capability: {
    description: "Check whether this business services a specific thing (a brand, a system type, a job type). Pass {\"query\": \"mini split\"}.",
    keywords: ["service", "offer", "do you", "capability", "repair", "install", "brand", "finance", "financing", "payment plan", "warranty"],
    async run({ scope, query: q }) {
      const term = normText(String(q || "").trim());
      if (!term) return { matched: false, items: [], note: "no search term given - this means UNKNOWN, not \"no\"" };
      const { rows } = await pool.query(
        "SELECT type, content, trigger FROM memories WHERE scope=$1 AND (content ILIKE $2 OR trigger ILIKE $2) ORDER BY confidence DESC LIMIT 5",
        [scope, `%${term.slice(0, 100)}%`]);
      return {
        matched: rows.length > 0, items: rows,
        note: rows.length > 0 ? undefined : "no memory found for this - this means UNKNOWN whether we do this, NOT a \"no\". Do not tell the customer we don't offer it.",
      };
    },
  },
  get_pricing: {
    description: "Look up THIS BUSINESS's own pricing/fees from memory (service call fee, diagnostic fee, etc) - NOT Joshua's own SaaS pricing. Pass {\"query\": \"diagnostic fee\"} or leave blank for general pricing facts.",
    keywords: ["price", "pricing", "cost", "fee", "charge", "how much", "rate", "quote"],
    async run({ scope, query: q }) {
      const term = normText(String(q || "").trim());
      const params = [scope];
      let sql = "SELECT type, content, trigger FROM memories WHERE scope=$1 AND (content ILIKE '%price%' OR content ILIKE '%cost%' OR content ILIKE '%fee%' OR content ILIKE '%$%' OR trigger ILIKE '%price%' OR trigger ILIKE '%cost%')";
      if (term) { sql += " AND (content ILIKE $2 OR trigger ILIKE $2)"; params.push(`%${term.slice(0, 100)}%`); }
      sql += " ORDER BY confidence DESC LIMIT 8";
      const { rows } = await pool.query(sql, params);
      return {
        matched: rows.length > 0, items: rows,
        note: rows.length > 0 ? undefined : "no pricing information on file for this business - this means UNKNOWN, not a specific number. Do not invent a price.",
      };
    },
  },
  check_service_area: { description: "Check whether a location/zip is inside this business's service area.", keywords: ["area", "zip", "location", "travel", "far"], async run() { return { stub: true, note: "not wired to real service-area data yet" }; } },
  check_calendar: {
    description: "There is no separate availability check. Call book_appointment directly with the date/time the customer wants - it will tell you if that slot doesn't work.",
    keywords: ["calendar", "availability", "schedule", "appointment", "when", "book"],
    async run() { return { stub: true, note: "no separate availability check exists - call book_appointment with the requested date/time instead" }; },
  },
  book_appointment: {
    description: "Book a real appointment on the calendar. Args: lead_name, lead_phone, appointment_date, appointment_time (natural language is fine - 'tomorrow', '9am', '2:30pm'), optionally lead_email, notes.",
    keywords: ["book", "schedule", "appointment", "reserve", "calendar"],
    async run({ scope, module, lead_name, lead_phone, appointment_date, appointment_time, lead_email, notes }) {
      if (!lead_name || !lead_phone || !appointment_date || !appointment_time) {
        return { result: "needs_more_info", message: "Need the customer's name, phone number, and a day + time before this can be booked." };
      }
      try {
        const r = await fetch("https://n8n-production-5955.up.railway.app/webhook/booking-guard", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lead_name, lead_phone, appointment_date, appointment_time, lead_email, notes, business_name: scope }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await r.json();
        if (data?.result === "booked") {
          await pool.query("INSERT INTO usage_events(scope, module, event_type, detail) VALUES ($1,$2,'success','booked_appointment')",
            [scope, String(module || "unassigned")]);
        }
        return data || { result: "error", message: "booking service returned no data" };
      } catch (e) {
        return { result: "error", message: "Could not reach the booking system: " + e.message };
      }
    },
  },
  create_lead: { description: "Create a new lead/contact in the CRM.", keywords: ["lead", "new customer", "contact", "crm"], async run() { return { stub: true, note: "not wired to a real CRM yet" }; } },
  update_lead: { description: "Update an existing lead/contact in the CRM.", keywords: ["update", "lead", "contact", "crm", "note"], async run() { return { stub: true, note: "not wired to a real CRM yet" }; } },
  notify_owner: { description: "Notify the business owner directly about something urgent.", keywords: ["notify", "alert", "owner", "urgent", "tell them"], async run() { return { stub: true, note: "not wired to a real notification channel yet" }; } },
  send_sms: { description: "Send a text message to the customer.", keywords: ["text", "sms", "message", "send"], async run() { return { stub: true, note: "not wired to a real SMS provider yet" }; } },
};
const RESPOND_MODEL = process.env.RESPOND_MODEL || REFLECT_MODEL;

// $ per token (not per million - keeps callCost() simple). Source: OpenRouter's
// own listed price for openai/gpt-oss-120b, checked 2026-09-13. This is a manual
// map - update it if RESPOND_MODEL ever changes to a different model.
const MODEL_RATES_PER_TOKEN = {
  "openai/gpt-oss-120b": { in: 0.03 / 1_000_000, out: 0.17 / 1_000_000 },
};
function callCost(model, tokensIn, tokensOut) {
  const rate = MODEL_RATES_PER_TOKEN[model];
  if (!rate) return null; // unknown model - don't pretend we know the cost
  return (tokensIn || 0) * rate.in + (tokensOut || 0) * rate.out;
}

// Flat monthly price per module, CONTRACTOR-facing (Variant A pricing).
// This is what the contractor is charged - separate from what it costs us.
const MODULE_PRICE_USD = {
  speed_to_lead: 250,
  lexi: 300,
  field_app: 180,
};

function toolBlock(names) {
  return names.map(n => `- ${n}: ${TOOL_LIBRARY[n].description}`).join("\n");
}

const RESPOND_SYS = (standingBlock, toolNames) => `You are the Contractor Brain for one specific contractor. Answer the incoming message directly and briefly, the way a sharp office manager would.
You have this business's known memory below - treat it as ground truth, do not contradict it:
${standingBlock || "(no memory recorded yet for this contractor)"}

TOOLS AVAILABLE RIGHT NOW:
${toolBlock(toolNames)}

This is not the full list of everything this brain can eventually do - it is only what is loaded for you this turn. If none of these fit what you need, call find_tools with a plain-language description of the task (e.g. "book an appointment", "what do we charge") and more tools will unlock for your next move.
Most non-core tools are STUBS during this build-out and will say so in their result - if a tool result has "stub": true, tell the truth: say you do not have that wired up yet rather than making something up.

HARD RULE: you have NO phone number, address, price, or contact detail of any kind unless it appears verbatim in the memory block above or in a tool result. Do not output any phone number, address, or price under any circumstances unless it is copied verbatim from memory or a tool result. If a customer asks to book or asks for contact info and you cannot do it yourself (a tool result says stub:true, or you have no tool for it), say exactly this kind of thing: "I cannot book that myself yet - someone from the team will follow up with you directly." Never invent a callback number or address to fill that gap. A tool result with no match (matched: false, or an empty items list) means you do not know the answer - it is NOT evidence the business doesn't offer something. Never turn "no memory found" into "we don't do that" - say you're not sure and someone will confirm.
To call a tool, end your reply with a line of the exact form:
ACTION: {"tool":"tool_name","args":{...}}
Only call a tool when you actually need it - a greeting or thank-you needs no tool. But if the customer asks anything about what THIS business does, offers, charges, financing, service area, hours, or any other business-specific fact, and that fact is not already sitting in the memory block above, you must check before answering - call find_tools (or a tool you already have loaded) first. Do not skip straight to "we don't have that" or "I'm not sure" without checking a tool - only say that AFTER a tool comes back with no match.`;

// A hard, code-level backstop: no model can be fully talked out of inventing a
// phone number via prompt alone (555-xxxx is the universal fake-number reflex
// across every model tested). Strip any phone-shaped string the model outputs
// unless it is verbatim in the contractor's own standing memory.
const PHONE_RE = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
function stripUnverifiedPhoneNumbers(text, standingBlock) {
  const norm = normText(String(text)); // catches smart hyphens (e.g. "555\u2011...") the raw regex would miss
  return norm.replace(PHONE_RE, (m) => (standingBlock && normText(standingBlock).includes(m)) ? m : "[no verified callback number on file]");
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

async function callModelOnce(messages) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: RESPOND_MODEL, temperature: 0.3, max_tokens: 500, messages }),
    signal: AbortSignal.timeout(30000),
  });
  const d = await r.json();
  if (d?.error) throw new Error(typeof d.error === "string" ? d.error : JSON.stringify(d.error));
  return {
    content: d?.choices?.[0]?.message?.content || "",
    tokensIn: d?.usage?.prompt_tokens ?? null,
    tokensOut: d?.usage?.completion_tokens ?? null,
  };
}

// The model sometimes comes back with whitespace-only content (seen live,
// roughly half the time on one test scope) - a real string, not an error,
// that just trims to nothing. Retry once before accepting that as the
// answer; tokens from both attempts count toward real cost either way.
async function callModel(messages, label) {
  let tokensIn = 0, tokensOut = 0;
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const r = await callModelOnce(messages);
    tokensIn += r.tokensIn || 0; tokensOut += r.tokensOut || 0;
    if (r.content && r.content.trim()) return { content: r.content, tokensIn, tokensOut };
    console.error(`[brain] model returned blank/whitespace content on attempt ${attempt}/${MAX_ATTEMPTS}${label ? " (" + label + ")" : ""}`);
  }
  return { content: "", tokensIn, tokensOut };
}

// Logs the real $ cost of one brain call against a scope+module. This is OUR
// internal cost tracking - the contractor never sees it. Separate on purpose
// from the contractor-facing billing trigger in /usage/status.
async function logAiCost(scope, module, tokensIn, tokensOut) {
  const cost = callCost(RESPOND_MODEL, tokensIn, tokensOut);
  await pool.query(
    "INSERT INTO usage_events(scope, module, event_type, detail, tokens_in, tokens_out, cost_usd) VALUES ($1,$2,'ai_call',$3,$4,$5,$6)",
    [scope, module, RESPOND_MODEL, tokensIn, tokensOut, cost]);
}

app.post("/v1/brain/respond", async (req, res) => {
  const scope = getScope(req);
  if (!scope) return res.status(400).json({ error: "valid scope required" });
  const { message = "", conversation_id = "", module = "unassigned" } = req.body || {};
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
    standingBlock = standingBlock.trim();

    // Progressive tool disclosure: start with only the "always" tools loaded.
    // find_tools unlocks more, mid-conversation, as the model asks for them -
    // never the full library dumped into the prompt up front.
    const unlocked = new Set(Object.keys(TOOL_LIBRARY).filter(n => TOOL_LIBRARY[n].always));
    const messages = [
      { role: "system", content: RESPOND_SYS(standingBlock, [...unlocked]) },
      { role: "user", content: String(message).slice(0, 4000) },
    ];

    let totalTokensIn = 0, totalTokensOut = 0;
    let finalText = "", lastAction = null, lastToolResult = null;
    const MAX_STEPS = 4; // find_tools -> real tool -> final answer, plus one spare

    for (let step = 0; step < MAX_STEPS; step++) {
      const call = await callModel(messages, `loop step ${step}, scope=${scope}`);
      totalTokensIn += call.tokensIn || 0; totalTokensOut += call.tokensOut || 0;
      if (!call.content || !call.content.trim()) console.error(`[brain] still-blank model content at step ${step} after all retries, scope=${scope}, messages=${messages.length}`);
      const { text, action } = parseAction(call.content);

      if (!action) {
        if (text && text.trim()) { finalText = text; break; }
        // Real root cause of the leftover blank-response cases (confirmed via
        // logs - the earlier blank/whitespace retries never fired for these):
        // content came back non-blank but was just a malformed/truncated
        // ACTION line with no usable text before it. Don't silently accept ""
        // as the final answer - nudge and let the model try again.
        console.error(`[brain] step ${step} had no usable text and no parseable action, scope=${scope}, raw="${String(call.content).slice(0, 200)}"`);
        messages.push({ role: "assistant", content: call.content });
        messages.push({ role: "user", content: "That didn't come through as a usable answer or a valid tool call - it looked like a broken or incomplete ACTION line. Give a plain-text answer now, or a properly formatted ACTION line if you truly need one more tool." });
        continue;
      }

      messages.push({ role: "assistant", content: call.content });

      if (action.tool === "find_tools") {
        const result = await TOOL_LIBRARY.find_tools.run({ scope, ...(action.args || {}) });
        (result.matches || []).forEach(m => unlocked.add(m.tool));
        messages[0] = { role: "system", content: RESPOND_SYS(standingBlock, [...unlocked]) };

        // Don't just hope the model follows through on a single obvious match -
        // call it now, deterministically, same reasoning as the phone-number
        // backstop below (prompt compliance alone isn't reliable enough here).
        if ((result.matches || []).length === 1 && TOOL_LIBRARY[result.matches[0].tool]) {
          const autoTool = result.matches[0].tool;
          const autoResult = await TOOL_LIBRARY[autoTool].run({ scope, module, ...(action.args || {}) });
          lastAction = autoTool; lastToolResult = autoResult;
          messages.push({ role: "user", content: `find_tools matched exactly one tool (${autoTool}), so it was called automatically. TOOL RESULT for ${autoTool}: ${JSON.stringify(autoResult)}\n\nNow give the final answer, plain text, no ACTION line unless you genuinely need one more tool.` });
          continue;
        }

        lastAction = action.tool; lastToolResult = result;
        messages.push({ role: "user", content: `TOOL RESULT for find_tools: ${JSON.stringify(result)}\n\nIf any of those tools are relevant to what the customer asked, you must call one of them now with an ACTION line - do not answer the customer yet. Only skip straight to a final answer if none of the tools returned are actually relevant to the question.` });
        continue;
      }

      if (unlocked.has(action.tool) && TOOL_LIBRARY[action.tool]) {
        const result = await TOOL_LIBRARY[action.tool].run({ scope, module, ...(action.args || {}) });
        lastAction = action.tool; lastToolResult = result;
        messages.push({ role: "user", content: `TOOL RESULT for ${action.tool}: ${JSON.stringify(result)}\n\nNow give the final answer, plain text, no ACTION line unless you genuinely need one more tool.` });
        continue;
      }

      lastAction = action.tool;
      lastToolResult = { error: `"${action.tool}" is not loaded yet - call find_tools first to discover it, or it may not exist.` };
      messages.push({ role: "user", content: `TOOL RESULT: ${JSON.stringify(lastToolResult)}` });
    }

    if (!finalText) {
      messages.push({ role: "user", content: "Give your final answer now, plain text only, no ACTION line." });
      const call = await callModel(messages, `final catch-up, scope=${scope}`);
      totalTokensIn += call.tokensIn || 0; totalTokensOut += call.tokensOut || 0;
      if (!call.content || !call.content.trim()) console.error(`[brain] still-blank model content at final catch-up after all retries, scope=${scope}, messages=${messages.length}`);
      finalText = parseAction(call.content).text;
    }
    finalText = stripUnverifiedPhoneNumbers(finalText, standingBlock);
    if (!finalText.trim()) {
      console.error(`[brain] finalText still empty after fallback retry, scope=${scope} - serving safe default`);
      finalText = "I'm not sure about that one - someone from our team will follow up with you directly.";
    }

    await pool.query("INSERT INTO trajectories(scope, session_id, role, content) VALUES ($1,$2,'assistant',$3)",
      [scope, String(conversation_id).slice(0, 200), finalText.slice(0, 20000)]);
    await logAiCost(scope, String(module).trim() || "unassigned", totalTokensIn, totalTokensOut);

    res.json({ response: finalText, action: lastAction, tool_result: lastToolResult, handoff: false });
  } catch (e) {
    res.status(502).json({ error: "brain respond failed: " + e.message, response: null, action: null, handoff: true });
  }
});


// ── MODULE ACTIVATION: the contractor-facing on/off switch ───────────────────
// A contractor turns a module on when they need it. That single action starts
// the billing clock (see /usage/status below) - nothing else has to happen
// for it to "just work" from their side.
app.post("/modules/activate", async (req, res) => {
  const scope = getScope(req);
  if (!scope) return res.status(400).json({ error: "valid scope required" });
  const module = String(req.body?.module || "").trim();
  if (!module) return res.status(400).json({ error: "module required" });
  const activatedAtOverride = req.body?.activated_at || null; // ops/test-only backdate, mirrors /usage/log
  const { rows } = await pool.query(
    `INSERT INTO module_activations (scope, module, status, activated_at, updated_at)
     VALUES ($1,$2,'active',COALESCE($3, now()),now())
     ON CONFLICT (scope, module) DO UPDATE SET
       status = 'active',
       activated_at = CASE WHEN module_activations.status = 'active' THEN module_activations.activated_at ELSE COALESCE($3, now()) END,
       deactivated_at = NULL,
       updated_at = now()
     RETURNING scope, module, status, activated_at`,
    [scope, module, activatedAtOverride]);
  await pool.query("INSERT INTO usage_events(scope, module, event_type, detail) VALUES ($1,$2,'invoked','activated')", [scope, module]);
  res.json({ ok: true, activation: rows[0] });
});

app.post("/modules/deactivate", async (req, res) => {
  const scope = getScope(req);
  if (!scope) return res.status(400).json({ error: "valid scope required" });
  const module = String(req.body?.module || "").trim();
  if (!module) return res.status(400).json({ error: "module required" });
  const { rows } = await pool.query(
    `UPDATE module_activations SET status='inactive', deactivated_at=now(), updated_at=now()
     WHERE scope=$1 AND module=$2 RETURNING scope, module, status, deactivated_at`,
    [scope, module]);
  res.json({ ok: true, activation: rows[0] || { scope, module, status: "inactive", note: "was never activated" } });
});

// Every contractor scope that has ever activated a module - the admin panel's
// "customer list." Without this there is no way to discover contractors at all.
app.get("/admin/scopes", async (req, res) => {
  const { rows } = await pool.query("SELECT DISTINCT scope FROM module_activations ORDER BY scope");
  res.json({ scopes: rows.map(r => r.scope) });
});

app.get("/modules/status", async (req, res) => {
  const scope = getScope(req);
  if (!scope) return res.status(400).json({ error: "valid scope required" });
  const { rows } = await pool.query(
    "SELECT module, status, activated_at, deactivated_at FROM module_activations WHERE scope=$1 ORDER BY module", [scope]);
  res.json({ modules: rows });
});

// ── USAGE: the raw activity log any module logs real work against ────────────
// Optional `created_at` lets ops/tests backfill a timestamp; real callers omit it.
app.post("/usage/log", async (req, res) => {
  const scope = getScope(req);
  if (!scope) return res.status(400).json({ error: "valid scope required" });
  const { module = "", event_type = "", detail = null, duration_ms = null, created_at = null } = req.body || {};
  if (!module || !["invoked", "success", "error"].includes(event_type)) {
    return res.status(400).json({ error: "module and a valid event_type (invoked|success|error) required" });
  }
  await pool.query(
    "INSERT INTO usage_events(scope, module, event_type, detail, duration_ms, created_at) VALUES ($1,$2,$3,$4,$5, COALESCE($6, now()))",
    [scope, module, event_type, detail ? String(detail).slice(0, 2000) : null, duration_ms, created_at]);
  res.json({ ok: true });
});

// ── BILLING TRIGGER: Rule 2 - bill starts on first real success, or 14 days
//    after activation, whichever comes first. This is the one place that rule
//    is implemented; the dollar amount on top of it is a separate decision.
app.get("/usage/status", async (req, res) => {
  const scope = getScope(req);
  if (!scope) return res.status(400).json({ error: "valid scope required" });
  const module = String(req.query.module || "").trim();
  if (!module) return res.status(400).json({ error: "module required" });

  const act = await pool.query("SELECT status, activated_at FROM module_activations WHERE scope=$1 AND module=$2", [scope, module]);
  if (!act.rowCount || !act.rows[0].activated_at) {
    return res.json({ module, active: false, billable: false, reason: "never activated" });
  }
  const { status, activated_at } = act.rows[0];

  const firstSuccess = await pool.query(
    "SELECT MIN(created_at) AS t FROM usage_events WHERE scope=$1 AND module=$2 AND event_type='success'", [scope, module]);
  const firstSuccessAt = firstSuccess.rows[0]?.t || null;

  const fourteenDaysMs = 14 * 24 * 3600 * 1000;
  const activatedMs = new Date(activated_at).getTime();
  const graceExpiresAt = new Date(activatedMs + fourteenDaysMs);
  const now = new Date();

  let billable = false, billingStartedAt = null, reason = "grace period - no success yet, 14 days not elapsed";
  if (firstSuccessAt) {
    billable = true; billingStartedAt = firstSuccessAt; reason = "first real success recorded";
  } else if (now >= graceExpiresAt) {
    billable = true; billingStartedAt = graceExpiresAt.toISOString(); reason = "14-day grace period elapsed with no success yet";
  }

  res.json({
    module, active: status === "active", activated_at, first_success_at: firstSuccessAt,
    grace_expires_at: graceExpiresAt.toISOString(), billable, billing_started_at: billingStartedAt, reason,
  });
});

// ── MARGIN: what we actually charge vs. what it actually costs us ────────────
// Contractor never sees this. Real AI $ cost (from ai_call events, logged by
// logAiCost) against the flat module price, per scope, per month. This is
// TOKEN COST ONLY - it does not yet include Railway compute or (once this is
// wired to real calls) Telnyx per-minute voice cost, which will matter far
// more than token cost once this is live on the phone.
app.get("/margin/status", async (req, res) => {
  const scope = getScope(req);
  if (!scope) return res.status(400).json({ error: "valid scope required" });
  const module = String(req.query.module || "").trim();
  if (!module) return res.status(400).json({ error: "module required" });
  const month = String(req.query.month || new Date().toISOString().slice(0, 7)); // "YYYY-MM"

  const { rows } = await pool.query(
    `SELECT COUNT(*) AS calls, COALESCE(SUM(tokens_in),0) AS tokens_in, COALESCE(SUM(tokens_out),0) AS tokens_out,
            COALESCE(SUM(cost_usd),0) AS cost_usd
     FROM usage_events
     WHERE scope=$1 AND module=$2 AND event_type='ai_call' AND to_char(created_at, 'YYYY-MM')=$3`,
    [scope, module, month]);
  const r = rows[0];
  const price = MODULE_PRICE_USD[module] ?? null;
  const cost = Number(r.cost_usd);
  const margin = price !== null ? price - cost : null;
  const marginPct = price ? Math.round((margin / price) * 1000) / 10 : null;

  res.json({
    scope, module, month,
    ai_calls: Number(r.calls), tokens_in: Number(r.tokens_in), tokens_out: Number(r.tokens_out),
    ai_cost_usd: Math.round(cost * 1e6) / 1e6,
    price_usd: price,
    margin_usd: margin !== null ? Math.round(margin * 100) / 100 : null,
    margin_pct: marginPct,
    note: "ai_cost_usd is token cost only - does not include Railway compute or telephony/voice minutes",
  });
});

// Bird's-eye view across every contractor for a month - flags anything worth a look.
app.get("/margin/summary", async (req, res) => {
  const month = String(req.query.month || new Date().toISOString().slice(0, 7));
  const { rows } = await pool.query(
    `SELECT scope, module, COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS cost_usd
     FROM usage_events
     WHERE event_type='ai_call' AND to_char(created_at, 'YYYY-MM')=$1
     GROUP BY scope, module ORDER BY cost_usd DESC`,
    [month]);
  const out = rows.map(r => {
    const price = MODULE_PRICE_USD[r.module] ?? null;
    const cost = Number(r.cost_usd);
    return {
      scope: r.scope, module: r.module, ai_calls: Number(r.calls),
      ai_cost_usd: Math.round(cost * 1e6) / 1e6, price_usd: price,
      margin_usd: price !== null ? Math.round((price - cost) * 100) / 100 : null,
    };
  });
  res.json({ month, rows: out });
});

const PORT = process.env.PORT || 8080;

// Listen immediately - do not make the HTTP port (and therefore any
// healthcheck) depend on the database being reachable yet.
app.listen(PORT, () => console.log(`[brain] listening on ${PORT}`));

async function initDbWithRetry() {
  const delays = [1000, 3000, 5000, 10000, 15000]; // ~34s of retries, then keep trying every 30s
  for (let i = 0; ; i++) {
    try {
      await initDb();
      console.log("[brain] DB ready");
      return;
    } catch (e) {
      console.error(`[brain] DB init attempt ${i + 1} failed: ${e.message}`);
      await new Promise(r => setTimeout(r, delays[Math.min(i, delays.length - 1)]));
    }
  }
}
initDbWithRetry();

if (AUTO_REFLECT) {
  console.log(`[brain] auto-reflect ON — every ${REFLECT_INTERVAL_MIN} min, scopes with >= ${REFLECT_MIN_ROWS} new rows`);
  setTimeout(autoReflectTick, 90_000); // first pass ~90s after boot
  setInterval(autoReflectTick, REFLECT_INTERVAL_MIN * 60_000);
}
