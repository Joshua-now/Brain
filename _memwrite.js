const BASE = "https://brain-production-d66d.up.railway.app";
const KEY = process.env.MEMORY_API_KEY || "";
const H = { Authorization: "Bearer " + KEY, "Content-Type": "application/json" };
const SCOPE = "owner:fluid";
const notes = [
  "The Field App's agent is named Bob. v1 job = voice-to-invoice: a tech calls Bob, states the job + dollar amount, and Bob creates a DRAFT invoice in the contractor's own tool (Jobber first). Bob never guesses a price; the tech states the amount.",
  "Bob/Field App connector design: the agent NEVER calls a vendor API directly. There is ONE normalized connector interface (findCustomer, createInvoice, sendInvoice, connect, refreshToken) with per-tool adapters behind it (Jobber v1, QuickBooks v2, Housecall Pro v3). Add a tool = write one adapter.",
  "Channel decision for field agents: use VOICE (Telnyx AI Assistant, same pattern as Anna), NOT SMS. Joshua repeatedly failed A2P/10DLC SMS approval (GoHighLevel x8, Telnyx x1, Twilio x1). Voice dodges the SMS approval wall and is what techs want in the field.",
  "Invoice delivery to the homeowner rides the VENDOR's verified system (Jobber sends it), never from Joshua's own number — this keeps the SMS-approval problem out of the loop entirely.",
  "Multi-tenant isolation rule: the Field App (Bob) and Lexi are customer-facing/multi-tenant. Each contractor is scope tenant:{id}, walled off with Postgres Row-Level Security. Never give customer-facing agents desktop/shell access or cross-tenant memory. Harbor and Forge are owner-side (owner:fluid).",
  "Unified APIs (Merge, Codat) do NOT cover field-service tools like Jobber/Housecall, and carry high floors: Merge is free for 3 accounts then $650/mo up to 10 (+$65/account); Codat has a ~$12-24k/yr platform fee. Decision: hand-build connectors now; reconsider Merge only when customers are scattered across many different accounting/CRM tools.",
  "Bob Field App build spec is saved at outputs/Bob_FieldApp_Build_Spec.md. The long pole is Jobber API access (register app in Jobber Developer Center, OAuth2 + GraphQL) — start it early. Confirm the pilot contractor is actually on Jobber before building the adapter.",
];
(async () => {
  for (const n of notes) {
    const r = await fetch(BASE + "/write", { method: "POST", headers: H, body: JSON.stringify({ scope: SCOPE, role: "note", content: n, signal: "decision" }) });
    console.log("write:", r.status);
  }
  const rf = await fetch(BASE + "/reflect", { method: "POST", headers: H, body: JSON.stringify({ scope: SCOPE }) });
  console.log("reflect:", await rf.text());
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
