/**
 * verify-isolation.js — proves the tenant wall actually holds, against the
 * LIVE public URL, using real HTTP requests and real credentials.
 *
 *     railway ssh --service brain "node /app/scripts/verify-isolation.js"
 *
 * It mints two throwaway TENANT keys and one OWNER key, attacks the API with
 * them, then revokes all three and deletes the data it created. The raw keys
 * exist only inside this process - they are never printed and never leave the
 * container. Output is PASS/FAIL lines only.
 *
 * A test that only checks the happy path proves nothing. Most of these cases
 * are attacks that MUST be refused.
 */
const crypto = require("crypto");
const { Pool } = require("pg");

const BASE = (process.env.SELF_URL || "https://brain-production-05ae.up.railway.app").replace(/\/+$/, "");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /railway\.internal/.test(process.env.DATABASE_URL || "") ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 8000,
});
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

const A_SCOPE = "tenant:00000000-0000-4000-8000-00000000000a";
const B_SCOPE = "tenant:00000000-0000-4000-8000-00000000000b";

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "   -> " + detail : "")); }
}

async function mint(role, scope, label) {
  const raw = "bk_" + crypto.randomBytes(32).toString("base64url");
  const { rows } = await pool.query(
    `INSERT INTO brain_keys (key_hash, key_prefix, role, scope, label)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [sha256(raw), raw.slice(0, 10), role, scope, label]);
  return { raw, id: rows[0].id };
}

async function call(key, method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: Object.assign({ "Content-Type": "application/json" }, key ? { Authorization: "Bearer " + key } : {}),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  let data = null;
  try { data = await r.json(); } catch { /* non-JSON is fine, status is what matters */ }
  return { status: r.status, data };
}

(async () => {
  console.log("Verifying tenant isolation against " + BASE + "\n");

  const A = await mint("TENANT", A_SCOPE, "ISOLATION TEST A (delete me)");
  const B = await mint("TENANT", B_SCOPE, "ISOLATION TEST B (delete me)");
  const O = await mint("OWNER", null, "ISOLATION TEST OWNER (delete me)");
  const denialsBefore = (await pool.query("SELECT count(*)::int n FROM auth_denials")).rows[0].n;

  try {
    // ── Authentication ──
    console.log("Authentication");
    check("no credential is refused", (await call(null, "GET", "/standing")).status === 401);
    check("garbage credential is refused", (await call("bk_not_a_real_key", "GET", "/standing")).status === 401);
    check("health stays public", (await call(null, "GET", "/health")).status === 200);

    // ── The happy path still works ──
    console.log("\nNormal operation");
    const w = await call(A.raw, "POST", "/write", { role: "user", content: "isolation probe alpha" });
    check("tenant A can write to its own scope", w.status === 200, "got " + w.status);
    const ownRows = (await pool.query("SELECT count(*)::int n FROM trajectories WHERE scope=$1", [A_SCOPE])).rows[0].n;
    check("the write landed under A's scope, not somewhere else", ownRows === 1, "rows=" + ownRows);

    // Seed a memory row for each tenant so the read tests have something to
    // either find or (correctly) not find.
    await pool.query("INSERT INTO memories(scope,type,content) VALUES ($1,'fact','ALPHA SECRET'),($2,'fact','BRAVO SECRET')", [A_SCOPE, B_SCOPE]);

    const standA = await call(A.raw, "GET", "/standing");
    check("tenant A reads its own memory", standA.status === 200 && /ALPHA SECRET/.test(standA.data?.block || ""));
    check("tenant A does NOT see tenant B's memory", !/BRAVO SECRET/.test(standA.data?.block || ""));

    // ── The attacks ──
    console.log("\nCross-tenant attempts (all of these MUST be refused)");
    const q = await call(A.raw, "GET", "/standing?scope=" + encodeURIComponent(B_SCOPE));
    check("A naming B's scope in the query string -> 403", q.status === 403, "got " + q.status);
    check("  ...and leaked nothing", !/BRAVO SECRET/.test(JSON.stringify(q.data || "")));

    const b = await call(A.raw, "POST", "/write", { scope: B_SCOPE, role: "user", content: "should never land" });
    check("A naming B's scope in the body -> 403", b.status === 403, "got " + b.status);
    const bRows = (await pool.query("SELECT count(*)::int n FROM trajectories WHERE scope=$1", [B_SCOPE])).rows[0].n;
    check("  ...and wrote nothing into B", bRows === 0, "rows=" + bRows);

    const rec = await call(A.raw, "GET", "/recall?scope=" + encodeURIComponent(B_SCOPE) + "&q=SECRET");
    check("A recalling against B's scope -> 403", rec.status === 403, "got " + rec.status);

    const del = await call(A.raw, "DELETE", "/memories/1?scope=" + encodeURIComponent(B_SCOPE));
    check("A deleting in B's scope -> 403", del.status === 403, "got " + del.status);

    console.log("\nPrivilege boundaries");
    check("tenant cannot list scopes", (await call(A.raw, "GET", "/admin/scopes")).status === 404);
    check("tenant cannot list keys", (await call(A.raw, "GET", "/keys")).status === 404);
    check("tenant cannot issue keys", (await call(A.raw, "POST", "/keys/issue", { role: "ADMIN" })).status === 404);
    check("tenant cannot read denials", (await call(A.raw, "GET", "/admin/denials")).status === 404);
    check("tenant cannot read margin summary", (await call(A.raw, "GET", "/margin/summary")).status === 404);
    check("tenant cannot trigger reflect", (await call(A.raw, "POST", "/reflect", {})).status === 403);

    console.log("\nOwner credential");
    check("owner with no scope is refused on a scoped route", (await call(O.raw, "GET", "/standing")).status === 400);
    check("owner with a malformed scope is refused", (await call(O.raw, "GET", "/standing?scope=../../etc")).status === 400);
    const oa = await call(O.raw, "GET", "/standing?scope=" + encodeURIComponent(A_SCOPE));
    check("owner naming a scope explicitly works", oa.status === 200, "got " + oa.status);
    check("owner cannot reach the admin surface", (await call(O.raw, "GET", "/admin/scopes")).status === 404);

    console.log("\nRevocation");
    await pool.query("UPDATE brain_keys SET status='REVOKED', revoked_at=now() WHERE id=$1", [A.id]);
    check("a revoked key stops working immediately", (await call(A.raw, "GET", "/standing")).status === 401);

    console.log("\nAudit");
    const denialsAfter = (await pool.query("SELECT count(*)::int n FROM auth_denials")).rows[0].n;
    check("refusals were recorded, not swallowed", denialsAfter > denialsBefore,
      denialsBefore + " -> " + denialsAfter);
  } finally {
    // Always clean up, even if an assertion threw.
    await pool.query("DELETE FROM brain_keys WHERE id = ANY($1)", [[A.id, B.id, O.id]]);
    await pool.query("DELETE FROM trajectories WHERE scope = ANY($1)", [[A_SCOPE, B_SCOPE]]);
    await pool.query("DELETE FROM memories WHERE scope = ANY($1)", [[A_SCOPE, B_SCOPE]]);
    await pool.query("DELETE FROM auth_denials WHERE attempted_scope = ANY($1) OR bound_scope = ANY($1)", [[A_SCOPE, B_SCOPE]]);
    console.log("\nTest keys revoked and deleted, test data removed.");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("verify failed to run:", e.message); process.exit(2); });
