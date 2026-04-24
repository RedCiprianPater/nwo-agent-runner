/**
 * HTTP route handlers — debug, status, manual trigger.
 */

import type { Env, AgentState } from "./types";
import { readAgentState } from "./conway";
import { getAgentBaseBalance } from "./wallet";

export async function handleHealth(env: Env): Promise<Response> {
  return new Response(JSON.stringify({
    ok: true,
    service: "nwo-agent-runner",
    timestamp: new Date().toISOString(),
    agent_wallet: env.AGENT_WALLET_ADDRESS,
    guardian: env.GUARDIAN_ADDRESS,
    conway: env.CONWAY_CONTRACT,
    config: {
      kimi_fallback_available: !!env.KIMI_API_KEY,
      github_token_set: !!env.GITHUB_TOKEN,
      hf_token_set: !!env.HF_TOKEN,
      identity_service_key_set: !!env.IDENTITY_SERVICE_KEY,
    },
  }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleStatus(env: Env): Promise<Response> {
  const id = env.COORDINATOR.idFromName("singleton");
  const stub = env.COORDINATOR.get(id);

  const [coordResp, onChain, ethBal] = await Promise.all([
    stub.fetch("http://do/state", { method: "GET" }).then(r => r.json()).catch(() => null),
    readAgentState(env).catch(err => ({ error: String(err) })),
    getAgentBaseBalance(env).then(b => b.toString()).catch(err => `err:${err}`),
  ]);

  return new Response(JSON.stringify({
    runner_state: coordResp,
    on_chain: onChain,
    agent_eth_balance_wei: ethBal,
    timestamp: new Date().toISOString(),
  }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleManualTrigger(request: Request, env: Env): Promise<Response> {
  // Optional: require a shared secret to prevent unauthenticated cycle triggering
  const authHeader = request.headers.get("Authorization");
  const expected = env.AGENT_GRAPH_POST_TOKEN;  // reuse; or add a dedicated trigger secret

  if (expected && authHeader !== `Bearer ${expected}`) {
    return new Response("forbidden", { status: 403 });
  }

  const id = env.COORDINATOR.idFromName("singleton");
  const stub = env.COORDINATOR.get(id);
  const resp = await stub.fetch("http://do/tick", { method: "POST" });
  const body = await resp.text();

  return new Response(body, {
    status: resp.status,
    headers: { "Content-Type": "application/json" },
  });
}
