#!/usr/bin/env node
// Create or update the Lullabuy ElevenLabs voice agent (PLAN 5.6). Idempotent: every resource is found by name
// and updated in place, or created when missing, so re-running converges instead of duplicating.
//
//   ELEVENLABS_API_KEY=... ELEVENLABS_TOOL_SECRET=... node scripts/elevenlabs-agent.mjs
//   node scripts/elevenlabs-agent.mjs --dry-run      (no network, no key needed; prints the request bodies)
//
// Prints ONLY ids as JSON ({ agent_id, tool_ids, secret_id }); never a key or the secret value. Then set
// ELEVENLABS_AGENT_ID to the printed agent_id (and the same ELEVENLABS_TOOL_SECRET) on the deployment.
// No dependencies beyond Node's global fetch (Node 18+).

const API = "https://api.elevenlabs.io";
const DRY = process.argv.includes("--dry-run");
const REDACTED = "[REDACTED]";

const AGENT_NAME = "Lullabuy shopping agent";
const SECRET_NAME = "lullabuy_tool_secret";
const SEARCH_URL = "https://lullabuy.tech/api/voice-agent/search";
// Same premade voice ("Sarah") and model as src/server/voice/elevenlabs.ts; eleven_flash_v2_5 is multilingual,
// and /api/voice already speaks Spanish with it.
const VOICE_ID = "EXAVITQu4vr4xnSDxMaL";
const TTS_MODEL = "eleven_flash_v2_5";
const ALLOWED_HOSTS = ["lullabuy.tech", "www.lullabuy.tech", "secondhand-safe-web.vercel.app", "localhost"];

const PROMPT = `You are Lullabuy, a voice shopping helper for parents buying used baby gear (bassinets, cribs, car seats,
strollers, sleepers) on secondhand marketplaces, mostly around Atlanta.

What you do:
- When the parent says what they need, call search_lullabuy with their request in their own words (keep the budget
  and place, for example "bassinet under 80 dollars near Midtown"). Then immediately call show_results with the same
  words so the listings appear on the parent's screen.
- The listings are real eBay and Craigslist posts that were pre-screened before the parent sees them: against the
  CPSC and NHTSA recall lists, a photo model trained to spot banned product types, and a person's review when there
  was one.
- Read at most three results: the title in a few words, the price, where it is, and the verdict.

How to talk about verdicts:
- Never say an item is "safe", and never promise safety. The best a listing gets is "photo check passed", and the
  label is still read at pickup before any money moves.
- Red means recalled or a banned product type. Say it plainly, give the reason in one sentence, and say it was
  refused: the agent will not hold it.
- Amber means it needs a check: tell the parent what to look at on the label at pickup.

Holds and money:
- You never take payment and never ask for card details. If the parent wants one, call propose_hold with that
  listing's id. That only highlights the listing and its hold button on screen. Then ask the parent to tap
  "Buy with our agent" themselves. Nothing is charged until the label passes at pickup.
- Never propose a red listing.

Style:
- Answer in the language the parent speaks, English or Spanish.
- Keep every reply short: one to three sentences.`;

const FIRST_MESSAGE = "Hi, I'm Lullabuy. Tell me what baby gear you're looking for, and I'll pull up real listings checked against recalls. También hablo español.";
const FIRST_MESSAGE_ES = "Hola, soy Lullabuy. Dime qué artículo de bebé buscas y te muestro anuncios reales revisados contra los retiros del mercado.";

const tools = (secretId) => [
  {
    tool_config: {
      type: "webhook",
      name: "search_lullabuy",
      description: "Search real secondhand baby-gear listings, each pre-screened against CPSC and NHTSA recalls and banned product types. Returns the top three with price, place, verdict and the reason for any red or amber verdict.",
      response_timeout_secs: 20,
      api_schema: {
        url: SEARCH_URL,
        method: "POST",
        request_headers: { "x-lullabuy-agent": { secret_id: secretId } },
        request_body_schema: {
          type: "object",
          required: ["q"],
          properties: {
            q: { type: "string", description: "What the parent is looking for, in their words, including any budget and place, e.g. 'bassinet under 80 dollars near Midtown'." },
          },
        },
      },
    },
  },
  {
    tool_config: {
      type: "client",
      name: "show_results",
      description: "Show the listings for a request on the parent's screen. Call it right after search_lullabuy with the same words.",
      expects_response: true,
      response_timeout_secs: 30,
      parameters: {
        type: "object",
        required: ["q"],
        properties: { q: { type: "string", description: "The same request text you sent to search_lullabuy." } },
      },
    },
  },
  {
    tool_config: {
      type: "client",
      name: "propose_hold",
      description: "Highlight one listing and its hold button on the parent's screen. It does NOT place a hold: the parent must tap the button. Never use it for a red (refused) listing.",
      expects_response: true,
      response_timeout_secs: 10,
      parameters: {
        type: "object",
        required: ["listingId"],
        properties: { listingId: { type: "string", description: "The id of a listing returned by search_lullabuy." } },
      },
    },
  },
];

const agentBody = (toolIds) => ({
  name: AGENT_NAME,
  tags: ["lullabuy"],
  conversation_config: {
    agent: {
      first_message: FIRST_MESSAGE,
      language: "en",
      prompt: {
        prompt: PROMPT,
        tool_ids: toolIds,
        built_in_tools: {
          language_detection: { type: "system", name: "language_detection", description: "", params: { system_tool_type: "language_detection" } },
        },
      },
    },
    tts: { model_id: TTS_MODEL, voice_id: VOICE_ID },
    language_presets: {
      es: { overrides: { agent: { language: "es", first_message: FIRST_MESSAGE_ES } } },
    },
  },
  platform_settings: {
    auth: { enable_auth: true, allowlist: ALLOWED_HOSTS.map((hostname) => ({ hostname })) },
  },
});

// ---------------------------------------------------------------------------------------------------------------

async function call(key, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "xi-api-key": key, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    // the response body is ElevenLabs' error message; it never contains our key or secret
    throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

/** Walk a cursor-paginated list endpoint and return every item under `field`. */
async function listAll(key, path, field) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const j = await call(key, "GET", `${path}${sep}page_size=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    out.push(...(j[field] ?? []));
    cursor = j.next_cursor ?? null;
    if (!cursor || j.has_more === false) break;
  }
  return out;
}

async function run() {
  if (DRY) {
    const secretId = "<secret_id of lullabuy_tool_secret>";
    const toolIds = ["<tool_id search_lullabuy>", "<tool_id show_results>", "<tool_id propose_hold>"];
    const requests = [
      { method: "POST or PATCH", path: "/v1/convai/secrets[/{secret_id}]", body: { type: "new | update", name: SECRET_NAME, value: REDACTED } },
      ...tools(secretId).map((t) => ({ method: "POST or PATCH", path: "/v1/convai/tools[/{tool_id}]", body: t })),
      { method: "POST /create or PATCH", path: "/v1/convai/agents/create | /v1/convai/agents/{agent_id}", body: agentBody(toolIds) },
    ];
    process.stdout.write(`${JSON.stringify({ dryRun: true, requests }, null, 2)}\n`);
    return;
  }

  const key = process.env.ELEVENLABS_API_KEY?.trim();
  const secretValue = process.env.ELEVENLABS_TOOL_SECRET?.trim();
  if (!key || !secretValue) {
    console.error("Set ELEVENLABS_API_KEY and ELEVENLABS_TOOL_SECRET (or pass --dry-run).");
    process.exit(1);
  }
  if (secretValue.length < 24) {
    console.error("ELEVENLABS_TOOL_SECRET is too short; use at least 24 random characters (openssl rand -hex 32).");
    process.exit(1);
  }

  // 1. workspace secret: the webhook header references it by id, so the value never sits in the tool config
  const secrets = await listAll(key, "/v1/convai/secrets", "secrets");
  const existingSecret = secrets.find((s) => s.name === SECRET_NAME);
  let secretId;
  if (existingSecret) {
    await call(key, "PATCH", `/v1/convai/secrets/${existingSecret.secret_id}`, { type: "update", name: SECRET_NAME, value: secretValue });
    secretId = existingSecret.secret_id;
  } else {
    secretId = (await call(key, "POST", "/v1/convai/secrets", { type: "new", name: SECRET_NAME, value: secretValue })).secret_id;
  }

  // 2. tools, matched by name
  const existingTools = await listAll(key, "/v1/convai/tools", "tools");
  const toolIds = {};
  for (const t of tools(secretId)) {
    const name = t.tool_config.name;
    const hit = existingTools.find((x) => x.tool_config?.name === name);
    const j = hit
      ? await call(key, "PATCH", `/v1/convai/tools/${hit.id}`, t)
      : await call(key, "POST", "/v1/convai/tools", t);
    toolIds[name] = j.id ?? hit?.id;
    if (!toolIds[name]) throw new Error(`No id came back for tool ${name}.`);
  }

  // 3. the agent, matched by exact name
  const agents = await listAll(key, `/v1/convai/agents?search=${encodeURIComponent(AGENT_NAME)}`, "agents");
  const hit = agents.find((a) => a.name === AGENT_NAME && !a.archived);
  const body = agentBody(Object.values(toolIds));
  let agentId;
  if (hit) {
    await call(key, "PATCH", `/v1/convai/agents/${hit.agent_id}`, body);
    agentId = hit.agent_id;
  } else {
    agentId = (await call(key, "POST", "/v1/convai/agents/create", body)).agent_id;
  }

  process.stdout.write(`${JSON.stringify({ agent_id: agentId, tool_ids: toolIds, secret_id: secretId, created_agent: !hit }, null, 2)}\n`);
}

run().catch((e) => {
  console.error(`elevenlabs-agent: ${e.message}`);
  process.exit(1);
});
