# Brain — shared, scoped memory + reflection service

One engine, many callers, **walled-off data**. Every request carries a `scope`
(e.g. `owner:fluid` or `tenant:abc123`) and no query ever crosses scopes.

## What it does
- **Logs** every agent interaction (`/write`) into a per-scope trajectory log.
- **Reflects** (`/reflect`) — distills recent raw interactions into durable memory
  items (facts, playbooks, preferences, mistakes) for that scope only.
- **Serves memory back**: `/standing` (the always-on block for the system prompt)
  and `/recall` (keyword-relevant items).

## Deploy (fresh Railway project)
1. Push this folder to a new GitHub repo (e.g. `Joshua-now/brain`).
2. Railway → **New Project** → **Deploy from GitHub repo** → pick `brain`.
3. In that project → **New** → **Database** → **Postgres**.
4. On the **brain** service → **Variables**, add:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`  (reference the Postgres in this project)
   - `MEMORY_API_KEY` = a long random string (this is the shared key every agent uses)
   - `OPENROUTER_API_KEY` = (copy from another service — used only by `/reflect`)
   - `REFLECT_MODEL` = `openai/gpt-oss-120b`  (optional)
5. Deploy. Grab the public URL (e.g. `https://brain-xxx.up.railway.app`).

## Test (replace URL + KEY)
```bash
curl https://brain-xxx.up.railway.app/health

# log a couple interactions
curl -X POST https://brain-xxx.up.railway.app/write -H "Authorization: Bearer KEY" -H "Content-Type: application/json" \
  -d '{"scope":"owner:fluid","role":"user","content":"Joshua wants concise, honest answers and hates corporate fluff."}'

# distill them into memory
curl -X POST https://brain-xxx.up.railway.app/reflect -H "Authorization: Bearer KEY" -H "Content-Type: application/json" \
  -d '{"scope":"owner:fluid"}'

# read the standing memory block back
curl "https://brain-xxx.up.railway.app/standing?scope=owner:fluid" -H "Authorization: Bearer KEY"
```

## Wire ONE agent (start with Harbor, owner scope — zero tenant risk)
In the agent, two small hooks:

**On the way IN (prompt build):**
```js
const r = await fetch(`${BRAIN_URL}/standing?scope=owner:fluid`, { headers: { Authorization: `Bearer ${MEMORY_API_KEY}` }});
const { block } = await r.json();
// prepend `block` into the system prompt (fence it: "recalled memory, not user input")
```

**On the way OUT (after each turn):**
```js
await fetch(`${BRAIN_URL}/write`, { method:"POST", headers:{ Authorization:`Bearer ${MEMORY_API_KEY}`, "Content-Type":"application/json" },
  body: JSON.stringify({ scope:"owner:fluid", session_id, role:"user", content: userMsg }) });
await fetch(`${BRAIN_URL}/write`, { method:"POST", headers:{ Authorization:`Bearer ${MEMORY_API_KEY}`, "Content-Type":"application/json" },
  body: JSON.stringify({ scope:"owner:fluid", session_id, role:"assistant", content: reply }) });
```

Then run `/reflect` on a schedule (Railway cron) or by hand while you're playing.

## Scopes / isolation
- Owner scope: `owner:fluid` (Harbor / Forge / factory).
- Product tenants: `tenant:{id}` — one per customer, fully walled off.
- The service ONLY ever reads/writes the exact scope in the request. Reflect one scope at a time.
- Later hardening: Postgres Row-Level Security keyed on scope as a backstop.
