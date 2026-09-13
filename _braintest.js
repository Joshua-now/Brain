const BASE = "https://brain-production-d66d.up.railway.app";
const KEY = process.env.MEMORY_API_KEY || "";
const H = { Authorization: "Bearer " + KEY, "Content-Type": "application/json" };
const SCOPE = "owner:fluid";
const j = async (r) => `${r.status} ${await r.text()}`;
(async () => {
  console.log("key length seen by test:", KEY.length);
  console.log("write1:", await j(await fetch(BASE + "/write", { method: "POST", headers: H, body: JSON.stringify({ scope: SCOPE, role: "user", content: "Joshua wants concise, honest answers and hates corporate fluff." }) })));
  console.log("write2:", await j(await fetch(BASE + "/write", { method: "POST", headers: H, body: JSON.stringify({ scope: SCOPE, role: "user", content: "A Railway env var holding a URL must include https:// or health checks throw Invalid URL.", signal: "correction" }) })));
  console.log("reflect:", await j(await fetch(BASE + "/reflect", { method: "POST", headers: H, body: JSON.stringify({ scope: SCOPE }) })));
  console.log("standing:", await j(await fetch(BASE + "/standing?scope=" + encodeURIComponent(SCOPE), { headers: H })));
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
