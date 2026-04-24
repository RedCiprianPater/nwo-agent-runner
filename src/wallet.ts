/**
 * Wallet · signs and broadcasts Conway transactions from the agent's key.
 *
 * Uses viem for EIP-1559 signing. Agent's private key lives in env.AGENT_PRIVATE_KEY
 * (Cloudflare secret, never logged).
 */

import type { Env } from "./types";
import { createWalletClient, http, encodeFunctionData, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// Minimal Conway ABI — extend as you add more callable methods
const CONWAY_ABI = parseAbi([
  "function purchaseAPITier(uint256 tier, uint256 amount) payable returns (bool)",
  "function confirmIntentFulfilled(uint256 nonce, bytes32 ethTxHash)",
  "function distributeRevenue(address agent) payable",
  "function spawnChild(string genesisPrompt) payable returns (address)",
]);

interface SignArgs {
  env: Env;
  method: "purchaseAPITier" | "confirmIntentFulfilled" | "distributeRevenue" | "spawnChild";
  args: any[];
  value_wei?: string;  // for payable methods
}

export async function signAndSendConway(args: SignArgs): Promise<string> {
  const { env, method, value_wei } = args;

  if (!env.AGENT_PRIVATE_KEY || !env.AGENT_PRIVATE_KEY.startsWith("0x")) {
    throw new Error("AGENT_PRIVATE_KEY not configured or invalid format");
  }

  const account = privateKeyToAccount(env.AGENT_PRIVATE_KEY as `0x${string}`);

  const client = createWalletClient({
    account,
    chain: base,
    transport: http(env.BASE_RPC),
  });

  // Normalize args — JSON over queue/DO may have turned uint256 into strings
  const normalizedArgs = args.args.map(a => {
    if (typeof a === "string" && /^\d+$/.test(a)) return BigInt(a);
    return a;
  });

  const data = encodeFunctionData({
    abi: CONWAY_ABI,
    functionName: method,
    args: normalizedArgs as any,
  });

  // Safety: cap gas we're willing to pay
  const gasPrice = await getGasPrice(env);
  const MAX_GAS_PRICE_GWEI = BigInt(100) * BigInt(10 ** 9);  // 100 gwei hard cap
  if (gasPrice > MAX_GAS_PRICE_GWEI) {
    throw new Error(`Gas price too high: ${gasPrice} wei > ${MAX_GAS_PRICE_GWEI}`);
  }

  const hash = await client.sendTransaction({
    to: env.CONWAY_CONTRACT as `0x${string}`,
    data: data as `0x${string}`,
    value: value_wei ? BigInt(value_wei) : undefined,
    gas: BigInt(500_000),  // generous; adjust based on observed usage
  });

  console.log(`[wallet] tx sent: ${hash} (${method})`);
  return hash;
}

async function getGasPrice(env: Env): Promise<bigint> {
  const resp = await fetch(env.BASE_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_gasPrice",
      params: [],
    }),
  });

  const json = await resp.json() as any;
  return BigInt(json.result);
}

/**
 * Quick balance checks — how much ETH does the agent have available?
 */
export async function getAgentBaseBalance(env: Env): Promise<bigint> {
  const resp = await fetch(env.BASE_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: [env.AGENT_WALLET_ADDRESS, "latest"],
    }),
  });

  const json = await resp.json() as any;
  return BigInt(json.result);
}
