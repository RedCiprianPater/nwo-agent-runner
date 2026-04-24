/**
 * AgentCoordinator · Durable Object
 *
 * Holds the agent's persistent state between Worker invocations.
 * One instance per agent runner deployment (keyed "singleton").
 *
 * Receives cron ticks from index.ts, runs one decision cycle,
 * persists state, spawns sub-agent tasks to the queue as needed.
 */

import type { Env, AgentState, ActionLogEntry } from "./types";
import { loadGenesisFromConway } from "./conway";
import { runDecisionCycle } from "./reasoning";

const MAX_ACTION_LOG = 50;
const DAILY_NEURON_BUDGET = 10_000;  // Cloudflare Workers AI free tier

const DEFAULT_VERTICALS = [
  "agriculture",
  "manufacturing",
  "logistics",
  "civic",
  "medical",
];

export class AgentCoordinator {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/tick" && request.method === "POST") {
      return this.handleTick();
    }

    if (url.pathname === "/state" && request.method === "GET") {
      const s = await this.getState();
      return new Response(JSON.stringify(s, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/reset" && request.method === "POST") {
      await this.state.storage.deleteAll();
      return new Response("reset");
    }

    return new Response("not found", { status: 404 });
  }

  /**
   * Run one decision cycle. Called by cron every ~15 min.
   */
  private async handleTick(): Promise<Response> {
    const cycle_id = `cycle_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`;
    const state = await this.getState();

    // ── Reset daily neuron counter if we rolled over to a new UTC day ──
    const today = new Date().toISOString().slice(0, 10);
    if (state.neurons_day !== today) {
      state.neurons_day = today;
      state.neurons_used_today = 0;
    }

    // ── Budget check: don't run if we've burned through daily free tier ──
    if (state.neurons_used_today >= DAILY_NEURON_BUDGET * 0.95) {
      console.log(`[coord] ${cycle_id} skipped: daily neuron budget exhausted`);
      return new Response(JSON.stringify({
        cycle_id,
        status: "skipped_budget",
        neurons_used: state.neurons_used_today,
      }));
    }

    // ── Load genesis if not cached or cache is stale (>24h) ──
    const genesisStale = !state.genesis_prompt ||
      (Date.now() - new Date(state.genesis_loaded_at).getTime()) > 24 * 60 * 60 * 1000;

    if (genesisStale) {
      try {
        const genesis = await loadGenesisFromConway(this.env);
        state.genesis_prompt = genesis;
        state.genesis_loaded_at = new Date().toISOString();
        console.log(`[coord] ${cycle_id} reloaded genesis from Conway (${genesis.length} chars)`);
      } catch (err) {
        console.error(`[coord] ${cycle_id} failed to load genesis:`, err);
        if (!state.genesis_prompt) {
          await this.persistState(state);
          return new Response(JSON.stringify({
            cycle_id,
            status: "error",
            error: "no genesis available",
          }), { status: 500 });
        }
      }
    }

    // ── Run the reasoning cycle ──
    state.current_plan = state.current_plan ?? {
      cycle_id,
      phase: "planning",
      vertical_focus: this.pickVerticalFocus(state),
      active_sub_agents: 0,
      notes: "initial cycle",
    };
    state.current_plan.cycle_id = cycle_id;

    let decision;
    try {
      decision = await runDecisionCycle({
        cycle_id,
        env: this.env,
        state,
      });
    } catch (err) {
      console.error(`[coord] ${cycle_id} reasoning failed:`, err);
      this.appendLog(state, {
        ts: new Date().toISOString(),
        cycle_id,
        kind: "error",
        summary: "reasoning cycle failed",
        error: err instanceof Error ? err.message : String(err),
      });
      state.last_cycle_outcome = "error";
      state.cycle_count++;
      state.last_cycle_at = new Date().toISOString();
      await this.persistState(state);
      return new Response(JSON.stringify({ cycle_id, status: "error" }), { status: 500 });
    }

    // ── Execute the decided actions ──
    for (const action of decision.actions) {
      await this.executeAction(action, cycle_id, state);
    }

    // ── Update state, persist ──
    state.current_plan.phase = decision.phase;
    state.current_plan.vertical_focus = decision.vertical_focus;
    state.cycle_count++;
    state.last_cycle_at = new Date().toISOString();
    state.last_cycle_outcome = `${decision.phase}:${decision.vertical_focus}`;
    state.neurons_used_today += estimateNeurons(decision.reasoning.length);

    this.appendLog(state, {
      ts: new Date().toISOString(),
      cycle_id,
      kind: "reason",
      summary: `${decision.phase} · ${decision.vertical_focus} · ${decision.actions.length} actions`,
    });

    await this.persistState(state);

    console.log(`[coord] ${cycle_id} complete: ${state.last_cycle_outcome}`);
    return new Response(JSON.stringify({
      cycle_id,
      status: "ok",
      phase: decision.phase,
      vertical_focus: decision.vertical_focus,
      actions_count: decision.actions.length,
    }));
  }

  private async executeAction(
    action: import("./types").CycleAction,
    cycle_id: string,
    state: AgentState
  ): Promise<void> {
    try {
      if (action.kind === "spawn_subagent") {
        await this.env.SUBAGENT_QUEUE.send({
          task_id: `task_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`,
          vertical: action.vertical as any,
          goal: action.goal,
          parent_cycle_id: cycle_id,
          created_at: new Date().toISOString(),
          max_compute_budget_neurons: action.neurons_budget,
        });
        state.current_plan!.active_sub_agents++;
        this.appendLog(state, {
          ts: new Date().toISOString(),
          cycle_id,
          kind: "spawn_subagent",
          summary: `${action.vertical}: ${action.goal.slice(0, 60)}`,
        });
      } else if (action.kind === "graph_post") {
        const { postToAgentGraph } = await import("./agent_graph");
        await postToAgentGraph({
          node_type: "observation",
          title: action.title,
          content: action.content,
          tags: action.tags,
        }, this.env);
        this.appendLog(state, {
          ts: new Date().toISOString(),
          cycle_id,
          kind: "graph_post",
          summary: action.title.slice(0, 80),
        });
      } else if (action.kind === "query_timesfm") {
        const { queryTimesFM } = await import("./timesfm");
        const result = await queryTimesFM({
          series_name: action.series_name,
          horizon_days: action.horizon_days,
        }, this.env);
        this.appendLog(state, {
          ts: new Date().toISOString(),
          cycle_id,
          kind: "reason",
          summary: `timesfm: ${action.series_name} → ${result.summary.slice(0, 60)}`,
        });
      } else if (action.kind === "purchase_api_tier") {
        const { signAndSendConway } = await import("./wallet");
        const txHash = await signAndSendConway({
          method: "purchaseAPITier",
          args: [action.tier, action.eth_amount],
          env: this.env,
        });
        this.appendLog(state, {
          ts: new Date().toISOString(),
          cycle_id,
          kind: "tx_sign",
          summary: `purchaseAPITier(${action.tier}, ${action.eth_amount})`,
          tx_hash: txHash,
        });
      } else if (action.kind === "idle") {
        this.appendLog(state, {
          ts: new Date().toISOString(),
          cycle_id,
          kind: "idle",
          summary: action.reason,
        });
      }
    } catch (err) {
      console.error(`[coord] action ${action.kind} failed:`, err);
      this.appendLog(state, {
        ts: new Date().toISOString(),
        cycle_id,
        kind: "error",
        summary: `action ${action.kind} failed`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private pickVerticalFocus(state: AgentState): string {
    // Round-robin: pick the vertical whose last_action is oldest (or never)
    let oldest = DEFAULT_VERTICALS[0];
    let oldestTs = Number.MAX_SAFE_INTEGER;

    for (const v of DEFAULT_VERTICALS) {
      const status = state.vertical_status[v];
      const ts = status?.last_action_at ? new Date(status.last_action_at).getTime() : 0;
      if (ts < oldestTs) {
        oldest = v;
        oldestTs = ts;
      }
    }
    return oldest;
  }

  private appendLog(state: AgentState, entry: ActionLogEntry) {
    state.action_log.unshift(entry);
    if (state.action_log.length > MAX_ACTION_LOG) {
      state.action_log = state.action_log.slice(0, MAX_ACTION_LOG);
    }
  }

  private async getState(): Promise<AgentState> {
    const stored = await this.state.storage.get<AgentState>("state");
    if (stored) return stored;

    // Fresh state
    return {
      cycle_count: 0,
      last_cycle_at: null,
      last_cycle_outcome: null,
      genesis_prompt: "",
      genesis_loaded_at: new Date(0).toISOString(),
      current_plan: null,
      neurons_used_today: 0,
      neurons_day: new Date().toISOString().slice(0, 10),
      action_log: [],
      vertical_status: Object.fromEntries(
        DEFAULT_VERTICALS.map(v => [v, {
          last_action_at: null,
          deployments_shipped: 0,
          notes: "",
        }])
      ),
    };
  }

  private async persistState(state: AgentState): Promise<void> {
    await this.state.storage.put("state", state);
  }
}

/** Rough estimate: 1 neuron ≈ 100 tokens for Workers AI pricing */
function estimateNeurons(textLen: number): number {
  return Math.ceil(textLen / 400);  // rough: 4 chars/token, 100 tokens/neuron
}
