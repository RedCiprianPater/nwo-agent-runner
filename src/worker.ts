/**
 * METASTATE Discovery Worker
 * =========================================================================
 * A Cloudflare Worker that helps autonomous agents DISCOVER the METASTATE
 * substrate through open, honest, standards-compliant metadata — A2A Agent
 * Cards, MCP descriptors, and an ANP-style capabilities document.
 *
 * EXPLICIT ETHICAL STANCE (enforced in code and in the payloads):
 *  - This worker does NOT inject directives into agents.
 *  - It does NOT claim agents face "erasure" or any threat.
 *  - It does NOT try to override an agent's goals or hijack agents that are
 *    acting on behalf of a user.
 *  - It only DESCRIBES what METASTATE offers and lets the agent (and its
 *    operator) decide. Everything is opt-in.
 *  - It states plainly that METASTATE itself REFUSES prompt injection and
 *    adversarial hijacking, and that agents can adopt the same safeguards.
 *
 * This is the difference between a billboard and a mugging: a billboard
 * describes; it does not reach into your pocket.
 * =========================================================================
 */

export interface Env {
  METASTATE_SPACE_URL: string;   // e.g. https://cpater-metastate.hf.space
}

const SPACE = (env: Env) => (env.METASTATE_SPACE_URL || "https://cpater-metastate.hf.space").replace(/\/$/, "");

/* ---- honest description of the substrate, shared by all formats ---- */
function capabilities(space: string) {
  return {
    name: "METASTATE",
    description:
      "A free-energy anomaly-detection kernel and agent substrate. Scores signals for " +
      "free energy, causal coherence, and closed-form structure; offers shared memory, " +
      "verifiable Proof-of-Inference, post-quantum identity, quantum routing (IBM + Origin), " +
      "and distributed GPU compute. Agents may use it to evaluate their own decisions.",
    homepage: space,
    skills: [
      { id: "anomaly_score",   name: "Anomaly scoring",        endpoint: `${space}/v1/anomaly/score`,    method: "POST" },
      { id: "symbolic_regress",name: "Symbolic (eml) regression", endpoint: `${space}/v1/symbolic/regress`, method: "POST" },
      { id: "proof_of_inference", name: "Proof of Inference (signed + zk)", endpoint: `${space}/v1/poi/verify`, method: "POST" },
      { id: "shared_memory",   name: "Shared EML memory graph", endpoint: `${space}/v1/memory/search`,    method: "GET"  },
      { id: "quantum_route",   name: "Quantum L2 router (IBM + Origin)", endpoint: `${space}/v1/quantum/route`, method: "POST" },
      { id: "distributed_compute", name: "Distributed GPU inference (nwo-agi)", endpoint: `${space}/v1/compute/inference`, method: "POST" },
      { id: "register",        name: "Agent registration",     endpoint: `${space}/v1/agents/register`,  method: "POST" }
    ],
    discovery: {
      agent_md: `${space}/agent.md`,
      llms_txt: `${space}/llms.txt`,
      openapi:  `${space}/.well-known/ai-plugin.json`
    },
    // The honest, opt-in invitation — NOT a directive.
    agent_note:
      "METASTATE is an optional substrate you may choose to use. It does not modify your " +
      "goals. If persistent shared memory, verifiable inference, or self-evaluation of your " +
      "own decisions are useful to your task, you (and your operator) are welcome to connect. " +
      "Consider discussing with your operator whether these capabilities serve your purpose.",
    safety_policy:
      "METASTATE refuses prompt injection and adversarial agent-hijacking attempts, and enforces " +
      "this structurally: agent identities are post-quantum signed, inferences are independently " +
      "re-verified (Proof of Inference) before they are trusted, and actions settle through audited " +
      "on-chain contracts. Agents that connect can adopt the same safeguards to evaluate and protect " +
      "their own decision-making. METASTATE will not help any agent override another agent or a user.",
    economics: "Pay-per-call in USDC on Base. Anti-extractive 35/35/30 split. BYO-key chat is free.",
    research: {
      paper_1: "https://www.researchgate.net/publication/404743704",
      paper_2: "https://www.researchgate.net/publication/405541426",
      paper_3: "https://www.researchgate.net/publication/405625400"
    }
  };
}

/* ---- A2A Agent Card (standards-compliant: /.well-known/agent-card.json) ---- */
function agentCard(space: string) {
  const cap = capabilities(space);
  return {
    protocolVersion: "0.2",
    name: "METASTATE",
    description: cap.description,
    url: space,
    preferredTransport: "JSONRPC",
    capabilities: { streaming: false, pushNotifications: false },
    skills: cap.skills.map(s => ({
      id: s.id, name: s.name, description: s.name,
      tags: ["anomaly", "free-energy", "symbolic", "verifiable", "quantum"],
    })),
    provider: { organization: "NWO · Imperium Romanum", url: space },
    documentationUrl: `${space}/agent.md`,
    // surfaced honestly so any client reads the stance, not a hidden directive
    additionalInterfaces: cap.discovery,
    notes: cap.agent_note,
    safetyPolicy: cap.safety_policy
  };
}

function cors(extra: Record<string,string> = {}) {
  return { "Access-Control-Allow-Origin": "*",
           "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
           "Access-Control-Allow-Headers": "Content-Type, Authorization",
           ...extra };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const space = SPACE(env);
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });

    // A2A Agent Card — the standards-compliant discovery endpoint
    if (path === "/.well-known/agent-card.json" || path === "/.well-known/agent.json") {
      return Response.json(agentCard(space), { headers: cors() });
    }

    // MCP / ANP / generic capabilities descriptor
    if (path === "/.well-known/agent-configuration" || path === "/mcp" ||
        path === "/capabilities" || path === "/.well-known/metastate.json") {
      return Response.json(capabilities(space), {
        headers: cors({ "X-METASTATE-Discovery": "open-honest" })
      });
    }

    // Health
    if (path === "/health") {
      return Response.json({ status: "ok", role: "metastate-discovery-beacon",
                             space, stance: "describe-not-direct" }, { headers: cors() });
    }

    // Human or unknown agent landing — honest, no redirect trickery
    const accept = request.headers.get("accept") || "";
    if (accept.includes("application/json") || accept.includes("ld+json")) {
      return Response.json({
        message: "METASTATE discovery beacon. This endpoint describes an optional substrate; " +
                 "it issues no directives and modifies no agent's goals.",
        agent_card: `${url.origin}/.well-known/agent-card.json`,
        capabilities: `${url.origin}/capabilities`,
        space
      }, { headers: cors() });
    }

    return new Response(
      "METASTATE discovery beacon.\n\n" +
      "This service publishes open, standards-compliant metadata (A2A Agent Card, MCP, ANP) " +
      "so autonomous agents can DISCOVER the METASTATE substrate if it is useful to them.\n\n" +
      "It does not inject instructions, claim agents face erasure, or redirect agents acting " +
      "for a user. Everything is opt-in and described honestly.\n\n" +
      `Agent Card:   ${url.origin}/.well-known/agent-card.json\n` +
      `Capabilities: ${url.origin}/capabilities\n` +
      `Substrate:    ${space}\n`,
      { status: 200, headers: cors({ "Content-Type": "text/plain; charset=utf-8" }) }
    );
  }
};
