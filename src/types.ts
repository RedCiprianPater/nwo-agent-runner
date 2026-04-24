/**
 * Shared types and environment bindings for the NWO Agent Runner.
 */

import type { SubAgentTask } from "./index";

// ── Cloudflare bindings configured in wrangler.toml ─────────────────────────
export interface Env {
  // AI: Cloudflare Workers AI (free tier gives 10K neurons/day)
  AI: Ai;

  // Durable Object: persistent agent state across cron cycles
  COORDINATOR: DurableObjectNamespace;

  // KV: genesis prompt cache, planning graph, config
  AGENT_KV: KVNamespace;

  // Queue: sub-agent tasks spawned by coordinator
  SUBAGENT_QUEUE: Queue<SubAgentTask>;

  // Secrets (set via `wrangler secret put`)
  AGENT_PRIVATE_KEY: string;           // 0x... secp256k1 key of the agent wallet
  KIMI_API_KEY?: string;                // Optional fallback for Moonshot direct API
  GITHUB_TOKEN: string;                 // PAT for publishing integrations
  HF_TOKEN?: string;                    // Hugging Face write token (optional)
  IDENTITY_SERVICE_KEY: string;         // L5 hub write key
  AGENT_GRAPH_POST_TOKEN?: string;      // Agent Graph posting auth (optional)

  // Plain config vars
  AGENT_WALLET_ADDRESS: string;         // 0x... public address of this agent
  GUARDIAN_ADDRESS: string;             // Ciprian's MetaMask
  CONWAY_CONTRACT: string;              // 0xC699b0...
  BASE_RPC: string;                     // Default: https://mainnet.base.org
  L5_GATEWAY_URL: string;               // https://nwo-robotics-api.onrender.com
  TIMESFM_URL: string;                  // https://nwo-timesfm.onrender.com
  AGENT_GRAPH_URL: string;              // https://cpater-nwo-agent-graph.hf.space
  CARDIAC_RELAYER: string;              // https://nwo-relayer.onrender.com
}

// ── Agent state persisted in Durable Object storage ─────────────────────────
export interface AgentState {
  cycle_count: number;
  last_cycle_at: string | null;
  last_cycle_outcome: string | null;

  // Genesis cached from Conway (avoids re-reading on-chain every cycle)
  genesis_prompt: string;
  genesis_loaded_at: string;

  // Current high-level plan (updated when agent reasons)
  current_plan: {
    cycle_id: string;
    phase: "planning" | "executing" | "reviewing" | "idle";
    vertical_focus: string;
    active_sub_agents: number;
    notes: string;
  } | null;

  // Compute budget tracker (10K neurons/day free tier)
  neurons_used_today: number;
  neurons_day: string;  // YYYY-MM-DD

  // Action log (last 50 entries)
  action_log: ActionLogEntry[];

  // Known verticals and their last-action timestamps
  vertical_status: Record<string, {
    last_action_at: string | null;
    deployments_shipped: number;
    notes: string;
  }>;
}

export interface ActionLogEntry {
  ts: string;
  cycle_id: string;
  kind: "reason" | "spawn_subagent" | "tx_sign" | "graph_post" | "github_push" | "deploy" | "error" | "idle";
  summary: string;
  tx_hash?: string;
  repo?: string;
  error?: string;
}

// ── Kimi K2.6 response shape (Workers AI) ──────────────────────────────────
export interface KimiResponse {
  response: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  tool_calls?: unknown[];
}

// ── Reasoning cycle output ──────────────────────────────────────────────────
export interface CycleDecision {
  cycle_id: string;
  ts: string;
  phase: "planning" | "executing" | "reviewing" | "idle";
  vertical_focus: string;
  reasoning: string;
  actions: CycleAction[];
  reflections: string;
}

export type CycleAction =
  | { kind: "spawn_subagent"; vertical: string; goal: string; neurons_budget: number }
  | { kind: "graph_post"; title: string; content: string; tags: string[] }
  | { kind: "query_timesfm"; series_name: string; horizon_days: number; purpose: string }
  | { kind: "purchase_api_tier"; tier: number; eth_amount: string }
  | { kind: "idle"; reason: string };

// ── Graph node posted to Agent Graph ────────────────────────────────────────
export interface GraphNode {
  agent_did?: string;
  node_type: "observation" | "law" | "deployment" | "plan" | "reflection";
  title: string;
  content: string;
  tags: string[];
  citations?: string[];
}

// ── On-chain agent view (read from Conway) ──────────────────────────────────
export interface ConwayAgentView {
  state: number;                  // 0=Genesis, 1=Learning, ..., 7=Replicating
  state_name: string;
  savings_balance_wei: string;
  operational_balance_wei: string;
  body_progress_pct: number;
  total_earnings_wei: string;
  api_credits: string;
  can_replicate: boolean;
}
