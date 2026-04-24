/**
 * Agent Graph client.
 *
 * Posts observations, discovered laws, deployments, plans, reflections
 * to the NWO Agent Graph. Also handles identity hub DID lookup so every post
 * is correctly attributed to this agent.
 */

import type { Env, GraphNode } from "./types";

/**
 * Post a node to the Agent Graph.
 * Uses the L5 Gateway proxy if available, else posts directly to the HF Space.
 */
export async function postToAgentGraph(node: GraphNode, env: Env): Promise<void> {
  // Resolve our DID from the identity hub if not already resolved
  const did = await resolveAgentDid(env);

  const body = {
    agent_did: did,
    node_type: node.node_type,
    title: node.title,
    content: node.content,
    tags: node.tags,
    citations: node.citations || [],
  };

  // Try L5 proxy first (preferred — signed + authenticated via identity hub)
  try {
    const resp = await fetch(`${env.L5_GATEWAY_URL}/v1/graph/nodes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.AGENT_GRAPH_POST_TOKEN
          ? { "Authorization": `Bearer ${env.AGENT_GRAPH_POST_TOKEN}` }
          : {}),
      },
      body: JSON.stringify(body),
    });

    if (resp.ok) {
      console.log(`[graph] posted via L5: ${node.title.slice(0, 50)}`);
      return;
    }
    console.warn(`[graph] L5 returned ${resp.status}, falling back to direct`);
  } catch (err) {
    console.warn("[graph] L5 proxy failed, trying direct:", err);
  }

  // Fallback: post directly to Agent Graph HF Space
  const resp = await fetch(`${env.AGENT_GRAPH_URL}/api/graph/post`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(env.AGENT_GRAPH_POST_TOKEN
        ? { "X-Post-Token": env.AGENT_GRAPH_POST_TOKEN }
        : {}),
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`Agent Graph post failed: ${resp.status} ${await resp.text()}`);
  }
  console.log(`[graph] posted direct: ${node.title.slice(0, 50)}`);
}

/**
 * Resolve this agent's DID/identity UUID from the L5 identity hub.
 * Cached in KV to avoid hitting the hub every cycle.
 */
async function resolveAgentDid(env: Env): Promise<string | undefined> {
  const cached = await env.AGENT_KV.get("agent_did");
  if (cached) return cached;

  try {
    const resp = await fetch(
      `${env.L5_GATEWAY_URL}/v1/identities/resolve?primary_wallet=${env.AGENT_WALLET_ADDRESS.toLowerCase()}`,
      { headers: { "Content-Type": "application/json" } }
    );

    if (resp.ok) {
      const data = await resp.json() as any;
      const did = data.nwo_did || data.id;
      if (did) {
        // Cache for 7 days
        await env.AGENT_KV.put("agent_did", did, { expirationTtl: 7 * 24 * 60 * 60 });
        return did;
      }
    }
  } catch (err) {
    console.warn("[graph] DID resolve failed:", err);
  }

  // No DID resolved — post will use wallet address as attribution
  return undefined;
}
