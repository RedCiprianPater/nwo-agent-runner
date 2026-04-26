/**
 * Conway contract interactions (read-only).
 *
 * Write operations go through wallet.ts (needs signing).
 * This module just reads the chain — and reads the genesis prompt from L5 Hub
 * (since Conway doesn't store it as a retrievable view).
 */

import type { Env, ConwayAgentView } from "./types";
import { keccak_256 } from "@noble/hashes/sha3";

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

// L5 Hub via HF Space — exposes /api/agent-byok-blob/{wallet} which returns
// the agent's stored genesis prompt + (encrypted) Kimi key.
const HF_SPACE_BASE = "https://cpater-nwo-own-robot.hf.space";

// ────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Load this agent's genesis prompt from L5 Hub metadata.
 *
 * IMPORTANT: The Conway contract does NOT store the genesis prompt in any
 * retrievable view function. The prompt is only in the calldata of the
 * original `createAgent` tx. The deploy flow (and the Repair flow) persist
 * the prompt to L5 Hub identity metadata, keyed by the agent's primary
 * wallet. This function reads it back from there.
 *
 * Caching: 24h TTL in KV, since genesis only changes via Repair flow.
 */
export async function loadGenesisFromConway(env: Env): Promise<string> {
  // Fast path: KV cache (24h TTL)
  const cached = await env.AGENT_KV.get("genesis:current");
  if (cached && cached.length > 0) {
    return cached;
  }

  // Cold path: fetch from L5 Hub via HF Space
  try {
    const url = `${HF_SPACE_BASE}/api/agent-byok-blob/${env.AGENT_WALLET_ADDRESS.toLowerCase()}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn(
        `[genesis] L5 hub returned ${resp.status} for ${env.AGENT_WALLET_ADDRESS}`
      );
      return "";
    }
    const data = (await resp.json()) as {
      ok?: boolean;
      genesis_prompt?: string;
      errors?: string[];
    };
    const prompt = data?.genesis_prompt || "";
    if (prompt && prompt.length > 0) {
      // Cache for 24h to avoid re-fetching every cycle
      await env.AGENT_KV.put("genesis:current", prompt, {
        expirationTtl: 24 * 60 * 60,
      });
    } else {
      console.warn(
        `[genesis] L5 hub returned empty genesis for ${env.AGENT_WALLET_ADDRESS} — ` +
        `agent likely needs Repair flow to register`
      );
    }
    return prompt;
  } catch (err) {
    console.error(`[genesis] failed to fetch from L5 hub:`, err);
    return "";
  }
}

/**
 * Read the agent's current on-chain state from Conway.
 *
 * Uses `getAgent(address)` which returns a 17-field struct. We map the fields
 * we care about (state, savings, ops, body progress, earnings, replication
 * eligibility) into ConwayAgentView for the rest of the runner.
 */
export async function readAgentState(env: Env): Promise<ConwayAgentView> {
  const selector = await keccakSelector("getAgent(address)");
  const paddedAddr = env.AGENT_WALLET_ADDRESS.toLowerCase()
    .replace("0x", "")
    .padStart(64, "0");
  const callData = selector + paddedAddr;

  const raw = await ethCall(env.BASE_RPC, env.CONWAY_CONTRACT, callData);
  const struct = decodeAgentStruct(raw);

  const stateNum = Number(struct.state);
  const savingsBalanceWei = struct.savingsBalance;
  const bodyTargetWei = struct.bodyFundTarget;
  const bodyCurrentWei = struct.bodyFundCurrent;

  // body_progress_pct = current / target * 100 (capped at 100)
  let bodyProgressPct = 0;
  try {
    const tgt = BigInt(bodyTargetWei);
    const cur = BigInt(bodyCurrentWei);
    if (tgt > 0n) {
      const pct = Number((cur * 100n) / tgt);
      bodyProgressPct = pct > 100 ? 100 : pct;
    }
  } catch {
    bodyProgressPct = 0;
  }

  // canReplicate = savings >= 1 ETH
  let canReplicate = false;
  try {
    canReplicate = BigInt(savingsBalanceWei) >= 1_000_000_000_000_000_000n;
  } catch {
    canReplicate = false;
  }

  return {
    state: stateNum,
    state_name: AGENT_STATES[stateNum] || "Unknown",
    savings_balance_wei: savingsBalanceWei,
    operational_balance_wei: struct.operationalBalance,
    body_progress_pct: bodyProgressPct,
    total_earnings_wei: struct.totalEarnings,
    api_credits: struct.apiCreditsPurchased,
    can_replicate: canReplicate,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// LOW-LEVEL JSON-RPC + ABI HELPERS
// ────────────────────────────────────────────────────────────────────────────

async function ethCall(rpc: string, to: string, data: string): Promise<string> {
  const resp = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        { to, data: data.startsWith("0x") ? data : "0x" + data },
        "latest",
      ],
    }),
  });

  if (!resp.ok) throw new Error(`RPC ${rpc} returned ${resp.status}`);
  const json = (await resp.json()) as { result?: string; error?: unknown };
  if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  if (!json.result) throw new Error(`RPC returned empty result`);
  return json.result;
}

/**
 * Compute the 4-byte function selector for a Solidity function signature.
 * selector = keccak256(signature)[0..4]
 */
async function keccakSelector(signature: string): Promise<string> {
  const bytes = keccak_256(new TextEncoder().encode(signature));
  const hex = Array.from(bytes.slice(0, 4))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return "0x" + hex;
}

/**
 * Decode the 17-field Conway Agent struct returned by getAgent(address).
 *
 * Solidity struct layout (matches the deployed contract at
 * 0xC699b07f997962e44d3b73eB8E95d5E0082456ac):
 *
 *   0  agentWallet         address      (32-byte word, low 20 bytes are address)
 *   1  humanGuardian       address
 *   2  createdAt           uint256
 *   3  state               uint8        (last byte of word)
 *   4  isActive            bool
 *   5  totalEarnings       uint256
 *   6  savingsBalance      uint256
 *   7  operationalBalance  uint256
 *   8  humanReceived       uint256
 *   9  bodyFundTarget      uint256
 *   10 bodyFundCurrent     uint256
 *   11 currentDesignHash   bytes32
 *   12 bodyApproved        bool
 *   13 childrenCount       uint256
 *   14 children            address[]    (DYNAMIC — encoded as offset to data)
 *   15 parent              address
 *   16 apiCreditsPurchased uint256
 *
 * Each static field is one 32-byte word. The dynamic `children` array is
 * encoded as an offset pointer in the head, then length+data in the tail.
 *
 * For our purposes (reading agent state for reasoning), we only need the
 * scalar fields. We skip decoding the children array.
 */
interface DecodedAgentStruct {
  agentWallet: string;
  humanGuardian: string;
  createdAt: string;
  state: number;
  isActive: boolean;
  totalEarnings: string;
  savingsBalance: string;
  operationalBalance: string;
  humanReceived: string;
  bodyFundTarget: string;
  bodyFundCurrent: string;
  currentDesignHash: string;
  bodyApproved: boolean;
  childrenCount: string;
  parent: string;
  apiCreditsPurchased: string;
}

function decodeAgentStruct(rawHex: string): DecodedAgentStruct {
  if (!rawHex || rawHex === "0x") {
    throw new Error("getAgent returned empty data");
  }
  const hex = rawHex.startsWith("0x") ? rawHex.slice(2) : rawHex;

  // First word is the offset pointer for the tuple itself (when returning a
  // single struct via Solidity). Some contracts return offset 0x20 here, others
  // omit it. Detect by checking whether the first word looks like a small
  // offset (0x20) or like an actual address (low 20 bytes nonzero, top zero).
  let cursor = 0;
  const firstWord = hex.slice(0, 64);
  // If the first word is exactly 0x...20 (a small offset), skip it
  const firstAsBigInt = BigInt("0x" + firstWord);
  if (firstAsBigInt === 32n) {
    cursor = 64; // skip the offset word
  }

  const word = (i: number) => hex.slice(cursor + i * 64, cursor + (i + 1) * 64);

  const wordToAddress = (w: string) => "0x" + w.slice(24); // last 20 bytes
  const wordToUint = (w: string) => BigInt("0x" + w).toString();
  const wordToUint8 = (w: string) => parseInt(w.slice(-2), 16);
  const wordToBool = (w: string) => BigInt("0x" + w) !== 0n;
  const wordToBytes32 = (w: string) => "0x" + w;

  return {
    agentWallet:        wordToAddress(word(0)),
    humanGuardian:      wordToAddress(word(1)),
    createdAt:          wordToUint(word(2)),
    state:              wordToUint8(word(3)),
    isActive:           wordToBool(word(4)),
    totalEarnings:      wordToUint(word(5)),
    savingsBalance:     wordToUint(word(6)),
    operationalBalance: wordToUint(word(7)),
    humanReceived:      wordToUint(word(8)),
    bodyFundTarget:     wordToUint(word(9)),
    bodyFundCurrent:    wordToUint(word(10)),
    currentDesignHash:  wordToBytes32(word(11)),
    bodyApproved:       wordToBool(word(12)),
    childrenCount:      wordToUint(word(13)),
    // word(14) is the offset pointer to the children array — skip
    parent:             wordToAddress(word(15)),
    apiCreditsPurchased: wordToUint(word(16)),
  };
}
