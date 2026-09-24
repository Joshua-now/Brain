/**
 * bootstrap-keys.js — mint the first ADMIN + OWNER keys for the Brain.
 *
 * Chicken-and-egg: /keys/issue needs an ADMIN key, and there are none yet.
 * This writes the first ones straight into brain_keys, bypassing HTTP. It is
 * the ONLY thing that ever needs to do that; every later key goes through
 * POST /keys/issue.
 *
 * Run it on the Brain container so it uses the service's own DATABASE_URL:
 *
 *     railway ssh --service brain "node /app/scripts/bootstrap-keys.js"
 *
 * The raw keys are written to /app/.keys.local.txt and are NEVER printed to
 * stdout — the console only ever shows the 10-character prefix, which is not
 * usable as a credential. Read the file, copy the keys into Railway, then
 * delete it. They are unrecoverable afterwards; reissue if lost.
 */
const crypto = require("crypto");
const fs = require("fs");
const { Pool } = require("pg");

const OUT = process.env.BOOTSTRAP_OUT || "/app/.keys.local.txt";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "off" || /railway\.internal/.test(process.env.DATABASE_URL || "")
    ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 8000,
});

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

async function mint(role, scope, label) {
  const raw = "bk_" + crypto.randomBytes(32).toString("base64url");
  const { rows } = await pool.query(
    `INSERT INTO brain_keys (key_hash, key_prefix, role, scope, label)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, key_prefix, role, scope, label`,
    [sha256(raw), raw.slice(0, 10), role, scope, label]);
  return { raw, record: rows[0] };
}

(async () => {
  const { rows: existing } = await pool.query(
    "SELECT count(*)::int n FROM brain_keys WHERE status='ACTIVE'");
  if (existing[0].n > 0 && process.env.BOOTSTRAP_FORCE !== "yes") {
    console.log(`Refusing: ${existing[0].n} active key(s) already exist.`);
    console.log("This script is for the first keys only. Use POST /keys/issue,");
    console.log("or set BOOTSTRAP_FORCE=yes if you really mean to add more.");
    await pool.end();
    process.exit(1);
  }

  const admin = await mint("ADMIN", null, "joshua admin (bootstrap)");
  const owner = await mint("OWNER", null, "fluid-os / Harbor (bootstrap)");

  fs.writeFileSync(OUT,
    [
      "Brain API keys - generated " + new Date().toISOString(),
      "Copy these into Railway, then DELETE this file.",
      "They are not recoverable. Reissue if lost.",
      "",
      "ADMIN  (your own admin/ops calls, and POST /keys/issue)",
      "  " + admin.raw,
      "",
      "OWNER  (set as MEMORY_API_KEY on the fluid-os service - Harbor)",
      "  " + owner.raw,
      "",
    ].join("\n"), { mode: 0o600 });

  // Prefixes only. Never the keys.
  console.log("Minted 2 keys. Raw values written to " + OUT + " (never printed).");
  console.table([admin.record, owner.record]);
  console.log("\nNext:");
  console.log("  1. Read " + OUT + " and copy both keys somewhere safe.");
  console.log("  2. Set MEMORY_API_KEY on the fluid-os service to the OWNER key.");
  console.log("  3. Set BRAIN_LEGACY_KEY=off on the brain service.");
  console.log("  4. Delete " + OUT + ".");
  await pool.end();
})().catch(e => { console.error("bootstrap failed:", e.message); process.exit(1); });
