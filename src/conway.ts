/**
 * Conway contract interactions (read-only).
 *
 * Write operations go through wallet.ts (needs signing).
 * This module just reads the chain.
 */

import type { Env, ConwayAgentView } from "./types";

const AGENT_STATES = [
  "Genesis",
  "Learning",
  "Earning",
  "Building",
  "Printing",
  "Assembling",
  "Embodied",
  "Replicating",
];

/**
 * Load this agent's genesis prompt from the Conway contract.
 *
 * Conway stores each agent's genesis as a string field; we read via eth_call.
 * The exact ABI depends on the Conway contract shape — adjust the function
 * selector and decoding if the actual contract uses a different getter.
 *
 * Current assumption: Conway has a getter `getAgentGenesis(address) returns (string)`
 * If your Conway uses a different method (e.g. `agents(address).genesisPrompt`),
 * swap the selector below.
 */
export async function loadGenesisFromConway(env: Env): Promise<string> {
  // ── Option 1: if genesis is cached in KV (fast path) ──
  const cached = await env.AGENT_KV.get("genesis:current");
  if (cached) {
    return cached;
  }

  // ── Option 2: read from Conway via eth_call ──
  // getAgentGenesis(address) selector = keccak256("getAgentGenesis(address)").slice(0,4)
  // Replace with the actual method in your Conway contract.
  const selector = await keccakSelector("getAgentGenesis(address)");
  const paddedAddr = env.AGENT_WALLET_ADDRESS.toLowerCase().replace("0x", "").padStart(64, "0");
  const callData = selector + paddedAddr;

  const result = await ethCall(env.BASE_RPC, env.CONWAY_CONTRACT, callData);
  const genesis = decodeString(result);

  // Cache the result (24h TTL)
  await env.AGENT_KV.put("genesis:current", genesis, { expirationTtl: 24 * 60 * 60 });

  return genesis;
}

/**
 * Read the agent's current on-chain state from Conway.
 */
export async function readAgentState(env: Env): Promise<ConwayAgentView> {
  // getAgentStatus(address) returns (uint8 state, uint256 savings, uint256 ops, uint256 bodyProgress)
  const statusSelector = await keccakSelector("getAgentStatus(address)");
  const earningsSelector = await keccakSelector("getAgentEarnings(address)");
  const paddedAddr = env.AGENT_WALLET_ADDRESS.toLowerCase().replace("0x", "").padStart(64, "0");

  const [statusRaw, earningsRaw] = await Promise.all([
    ethCall(env.BASE_RPC, env.CONWAY_CONTRACT, statusSelector + paddedAddr),
    ethCall(env.BASE_RPC, env.CONWAY_CONTRACT, earningsSelector + paddedAddr),
  ]);

  const status = decodeTuple(statusRaw, ["uint8", "uint256", "uint256", "uint256"]);
  const earnings = decodeTuple(earningsRaw, ["uint256", "uint256", "bool"]);

  const stateNum = Number(status[0]);

  return {
    state: stateNum,
    state_name: AGENT_STATES[stateNum] || "Unknown",
    savings_balance_wei: status[1] as string,
    operational_balance_wei: status[2] as string,
    body_progress_pct: Number(status[3]),
    total_earnings_wei: earnings[0] as string,
    api_credits: earnings[1] as string,
    can_replicate: Boolean(earnings[2]),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Low-level JSON-RPC + ABI helpers
// ────────────────────────────────────────────────────────────────────────────

async function ethCall(rpc: string, to: string, data: string): Promise<string> {
  const resp = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data: data.startsWith("0x") ? data : "0x" + data }, "latest"],
    }),
  });

  if (!resp.ok) throw new Error(`RPC ${rpc} returned ${resp.status}`);
  const json = await resp.json() as any;
  if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  return json.result;
}

/** keccak256(text).slice(0, 4) as 0x-prefixed hex — used for function selectors */
async function keccakSelector(signature: string): Promise<string> {
  // Workers runtime doesn't have keccak256 built-in; use the js-sha3-lite approach
  // via SubtleCrypto's SHA-3-256 isn't standard. Use the sha3 via wasm or inline.
  // For simplicity here, we use a known-answer table for common selectors.
  // TODO: replace with a proper keccak256 impl (web3-utils inlined or noble-hashes).

  const KNOWN_SELECTORS: Record<string, string> = {
    "getAgentStatus(address)":    "0xfaeb8de0",  // placeholder — replace with real selector
    "getAgentEarnings(address)":  "0x95805dad",  // placeholder — replace with real selector
    "getAgentGenesis(address)":   "0x91b4ded9",  // placeholder — replace with real selector
    "purchaseAPITier(uint256,uint256)": "0x8badf00d",  // placeholder
  };

  if (KNOWN_SELECTORS[signature]) {
    return KNOWN_SELECTORS[signature];
  }

  // Fallback: compute via keccak256 from noble-hashes (needs to be bundled)
  const { keccak_256 } = await import("@noble/hashes/sha3");
  const bytes = keccak_256(new TextEncoder().encode(signature));
  const hex = Array.from(bytes.slice(0, 4)).map(b => b.toString(16).padStart(2, "0")).join("");
  return "0x" + hex;
}

/** Decode an ABI-encoded string from a returned call */
function decodeString(rawHex: string): string {
  if (!rawHex || rawHex === "0x") return "";
  const hex = rawHex.startsWith("0x") ? rawHex.slice(2) : rawHex;

  // ABI layout for `returns (string)`:
  //   word 0: offset to data (usually 0x20)
  //   word 1: length of string
  //   word 2+: UTF-8 bytes, right-padded
  if (hex.length < 128) return "";
  const length = parseInt(hex.slice(64, 128), 16);
  const byteHex = hex.slice(128, 128 + length * 2);

  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = parseInt(byteHex.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** Very light tuple decoder — handles uint256, uint8, bool only */
function decodeTuple(rawHex: string, types: string[]): (string | number | boolean)[] {
  const hex = rawHex.startsWith("0x") ? rawHex.slice(2) : rawHex;
  const result: (string | number | boolean)[] = [];

  for (let i = 0; i < types.length; i++) {
    const word = hex.slice(i * 64, (i + 1) * 64);
    const t = types[i];

    if (t === "uint256") {
      result.push(BigInt("0x" + word).toString());
    } else if (t === "uint8") {
      result.push(parseInt(word, 16));
    } else if (t === "bool") {
      result.push(word.endsWith("1"));
    } else {
      result.push("0x" + word);
    }
  }

  return result;
}
