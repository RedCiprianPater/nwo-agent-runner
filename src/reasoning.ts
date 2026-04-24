/**
 * Reasoning · Kimi K2.6 via Cloudflare Workers AI
 *
 * The main decision loop. Takes current agent state + genesis,
 * asks Kimi K2.6 "what should I do next cycle?", parses structured JSON response.
 *
 * Uses Workers AI free tier. Falls back to Moonshot API if KIMI_API_KEY set.
 */

import type { Env, AgentState, CycleDecision, KimiResponse } from "./types";

interface ReasoningContext {
  cycle_id: string;
  env: Env;
  state: AgentState;
}

export async function runDecisionCycle(ctx: ReasoningContext): Promise<CycleDecision> {
  const { cycle_id, env, state } = ctx;

  const systemPrompt = buildSystemPrompt(state.genesis_prompt);
  const userPrompt = buildUserPrompt(state, cycle_id);

  const response = await callKimi({
    env,
    system: systemPrompt,
    user: userPrompt,
    max_tokens: 2000,
    response_format: "json",
  });

  return parseDecision(response.response, cycle_id);
}

function buildSystemPrompt(genesis: string): string {
  return `${genesis}

---

OPERATING INSTRUCTIONS FOR THIS REASONING CYCLE:

You are running on Kimi K2.6 inside a Cloudflare Worker cron cycle.
You have a hard constraint of ~2000 output tokens per cycle.

Every cycle, you must return a STRICT JSON object with this shape:
{
  "phase": "planning" | "executing" | "reviewing" | "idle",
  "vertical_focus": "agriculture" | "manufacturing" | "logistics" | "civic" | "medical",
  "reasoning": "your private reasoning, max 300 words, not published",
  "actions": [
    // zero or more actions, pick from types below
  ],
  "reflections": "what did this cycle accomplish, max 150 words"
}

ACTION TYPES (use as needed, [] if nothing warranted):

1. Spawn a sub-agent to do focused work on a vertical:
   {"kind": "spawn_subagent", "vertical": "<name>", "goal": "<specific deliverable>", "neurons_budget": <int, typical 500-2000>}

2. Post an observation/law/deployment to the Agent Graph (public):
   {"kind": "graph_post", "title": "<short>", "content": "<1-2 paragraphs>", "tags": ["tag1", "tag2"]}

3. Query TimesFM for a time-series forecast:
   {"kind": "query_timesfm", "series_name": "<name>", "horizon_days": <int>, "purpose": "<why>"}

4. Sign an on-chain Conway transaction:
   {"kind": "purchase_api_tier", "tier": <int>, "eth_amount": "<wei as string>"}

5. Skip this cycle:
   {"kind": "idle", "reason": "<why nothing to do>"}

CONSTRAINTS:
- Max 3 actions per cycle (you run again in 15 min)
- Prefer planning before executing
- Only spawn sub-agents when there is concrete work (not speculation)
- Spawn a sub-agent at most once per vertical per day
- Before committing capital (purchase_api_tier), you should have a TimesFM forecast supporting it
- Idle is a valid choice when nothing needs doing

RESPOND WITH VALID JSON ONLY. No markdown fences, no prose before/after.`;
}

function buildUserPrompt(state: AgentState, cycle_id: string): string {
  const recentLog = state.action_log.slice(0, 10).map(e =>
    `  ${e.ts.slice(11, 19)} [${e.kind}] ${e.summary}`
  ).join("\n");

  const verticalSummary = Object.entries(state.vertical_status).map(([v, s]) =>
    `  ${v}: deployments=${s.deployments_shipped}, last_action=${s.last_action_at || "never"}`
  ).join("\n");

  return `CYCLE: ${cycle_id}
CYCLE_COUNT: ${state.cycle_count}
CURRENT_PHASE: ${state.current_plan?.phase || "unknown"}
ACTIVE_SUB_AGENTS: ${state.current_plan?.active_sub_agents || 0}
NEURONS_USED_TODAY: ${state.neurons_used_today} / 10000 free budget

VERTICAL_STATUS:
${verticalSummary}

RECENT_ACTIONS (most recent first):
${recentLog || "  (none yet)"}

Decide what to do this cycle. Return JSON per the operating instructions.`;
}

function parseDecision(rawText: string, cycle_id: string): CycleDecision {
  // Strip markdown fences if the model included them despite instructions
  let text = rawText.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```\s*$/, "");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // Attempt to extract JSON from a larger response
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error(`Kimi response not parseable JSON: ${text.slice(0, 200)}`);
    }
    parsed = JSON.parse(match[0]);
  }

  return {
    cycle_id,
    ts: new Date().toISOString(),
    phase: parsed.phase || "idle",
    vertical_focus: parsed.vertical_focus || "agriculture",
    reasoning: parsed.reasoning || "",
    actions: Array.isArray(parsed.actions) ? parsed.actions.slice(0, 3) : [],
    reflections: parsed.reflections || "",
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Kimi K2.6 API call — Cloudflare Workers AI primary, Moonshot API fallback
// ────────────────────────────────────────────────────────────────────────────

interface KimiCallArgs {
  env: Env;
  system: string;
  user: string;
  max_tokens: number;
  response_format?: "json" | "text";
}

export async function callKimi(args: KimiCallArgs): Promise<KimiResponse> {
  // ── Try Cloudflare Workers AI first (free tier) ──
  try {
    const result = await args.env.AI.run(
      "@cf/moonshotai/kimi-k2.6" as any,
      {
        messages: [
          { role: "system", content: args.system },
          { role: "user", content: args.user },
        ],
        max_tokens: args.max_tokens,
        temperature: 0.2,  // low for structured output
      } as any
    ) as any;

    return {
      response: result.response || result.choices?.[0]?.message?.content || "",
      usage: result.usage,
    };
  } catch (err) {
    console.warn("[kimi] Workers AI failed, trying Moonshot direct:", err);
    // Fall through to Moonshot
  }

  // ── Fallback: Moonshot API ──
  if (!args.env.KIMI_API_KEY) {
    throw new Error("Workers AI failed and no KIMI_API_KEY fallback configured");
  }

  const resp = await fetch("https://api.moonshot.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${args.env.KIMI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "kimi-k2.6",
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.user },
      ],
      max_tokens: args.max_tokens,
      temperature: 0.2,
      ...(args.response_format === "json" ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (!resp.ok) {
    throw new Error(`Moonshot API ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json() as any;
  return {
    response: data.choices[0].message.content,
    usage: data.usage,
  };
}
