# NWO Agent Runner

Cloudflare Worker that brings a Conway agent to life. Runs Kimi K2.6 on a 15-minute cycle, reasons about the agent's genesis prompt, spawns sub-agents for parallel vertical work, signs Conway transactions, posts to Agent Graph.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      Cloudflare Worker                         │
│                                                                │
│  Cron (every 15 min)                                           │
│         ↓                                                      │
│  AgentCoordinator (Durable Object)                             │
│   · Loads genesis from Conway (cached in KV)                   │
│   · Calls Kimi K2.6 via Workers AI (free tier)                 │
│   · Parses structured decision JSON                            │
│   · Executes actions:                                          │
│        - Spawn sub-agents → Queue                              │
│        - Post to Agent Graph                                   │
│        - Query TimesFM                                         │
│        - Sign Conway txs (via viem)                            │
│   · Persists state                                             │
│                                                                │
│  Queue Consumer (async)                                        │
│   · Picks up sub-agent tasks                                   │
│   · Runs focused Kimi reasoning                                │
│   · Posts sub-agent output to Agent Graph                      │
└──────────────────────────────────────────────────────────────┘
         ↓                                    ↓
    Base mainnet                        NWO services
    · Conway contract              · L5 Identity Hub
    · purchaseAPITier()            · Agent Graph
    · confirmIntentFulfilled()     · TimesFM
                                   · Cardiac Relayer
```

## Prerequisites

- Cloudflare account (free tier works)
- Node 18+ and npm
- An agent wallet (from Own Robot deployment — the private key you saved)
- Conway contract agent deployment done (you have an `agent_wallet_address`)
- GitHub personal access token with `repo` + `workflow` scopes
- (Optional) Moonshot API key as fallback if Workers AI rate-limits

## Setup — first deploy

```bash
# 1. Install dependencies
cd agent-runner
npm install

# 2. Log into Cloudflare
npx wrangler login

# 3. Create the KV namespace (one-time)
npx wrangler kv:namespace create AGENT_KV
# → Update wrangler.toml `id = "..."` field with the returned ID

# 4. Create the Queues (one-time)
npx wrangler queues create nwo-subagent-tasks
npx wrangler queues create nwo-subagent-dlq

# 5. Edit wrangler.toml — replace these placeholders:
#    AGENT_WALLET_ADDRESS → your deployed agent's wallet (from Own Robot)
#    GUARDIAN_ADDRESS     → your MetaMask address (Ciprian's)
#    (KV id → already done in step 3)

# 6. Set all secrets (values never committed)
npx wrangler secret put AGENT_PRIVATE_KEY
#   → paste the 0x private key you saved from Own Robot's local wallet modal

npx wrangler secret put KIMI_API_KEY
#   → paste your Moonshot API key (optional but recommended as fallback)

npx wrangler secret put GITHUB_TOKEN
#   → paste a GitHub PAT with repo + workflow scopes

npx wrangler secret put HF_TOKEN
#   → paste your HF write token (optional; only if agent will deploy HF Spaces)

npx wrangler secret put IDENTITY_SERVICE_KEY
#   → your L5 identity hub service key (from L5 Render env)

npx wrangler secret put AGENT_GRAPH_POST_TOKEN
#   → optional; set if Agent Graph requires auth for posting

# 7. Deploy!
npx wrangler deploy
```

After deploy you'll get a URL like `https://nwo-agent-runner.your-subdomain.workers.dev`.

## Verify it's working

```bash
# Health check — confirms secrets + config loaded
curl https://nwo-agent-runner.your-subdomain.workers.dev/health

# Status — shows agent state, on-chain view, ETH balance
curl https://nwo-agent-runner.your-subdomain.workers.dev/status

# Manually trigger a reasoning cycle (skips waiting for cron)
curl -X POST https://nwo-agent-runner.your-subdomain.workers.dev/trigger \
  -H "Authorization: Bearer YOUR_AGENT_GRAPH_POST_TOKEN"

# Tail logs in real-time (useful for first run)
npx wrangler tail
```

## What happens on each cycle

Every 15 minutes:

1. Cron fires → coordinator DO wakes up
2. Checks daily neuron budget (10k/day free on Workers AI)
3. Reloads genesis from Conway if cache is stale (>24h)
4. Builds a context prompt: current state + recent actions + vertical status
5. Calls Kimi K2.6 → receives structured JSON decision
6. Executes 0-3 actions (spawning sub-agents, posting to graph, signing tx, querying TimesFM)
7. Persists state + logs cycle outcome

Sub-agent tasks queued during step 6 are processed asynchronously by the queue consumer — each one runs its own focused Kimi reasoning with a smaller budget.

## Cost analysis (first month)

Assuming 96 cycles/day (every 15 min), each cycle ~1500 input + 1000 output tokens:

**On Cloudflare Workers AI (preferred path):**
- ~25 neurons per cycle = 2,400 neurons/day
- Free tier budget: 10,000/day
- **Cost: $0/mo** until sub-agents push past free tier

**If you fall back to Moonshot API:**
- ~2,500 tokens/cycle × 96 cycles × 30 days = 7.2M tokens/mo
- At Kimi K2.6 pricing ($0.75/M input, $4.66/M output): ~$15-30/mo
- Covered by agent's 30% operational split once agent earns ~0.05 ETH/mo

**Cloudflare Worker runtime itself:**
- Free tier: 100k requests/day, 10ms CPU/request
- Cron triggers count as requests. 96/day for 30 days = 2880/mo. Trivial.
- **Cost: $0/mo** on free tier

## Shutting it down

```bash
# Pause the cron (stops cycles but keeps state)
# Edit wrangler.toml, comment out the [triggers] section, redeploy

# Or: delete entirely
npx wrangler delete
```

## Common issues

### "Workers AI failed" on first deploy

Cloudflare Workers AI access might not be enabled on your account. Go to Cloudflare Dashboard → AI → Enable. Or set `KIMI_API_KEY` so it falls back to Moonshot.

### "No genesis available"

The `loadGenesisFromConway` method in `src/conway.ts` needs the correct function selector for your actual Conway contract's genesis-reading method. The placeholder selectors are guesses — you'll need to:

1. Look at your Conway contract's ABI
2. Find the method that returns an agent's genesis prompt (might be called `agents(address)` returning a struct, or `getGenesis(address)`)
3. Compute the 4-byte selector: `keccak256("methodName(paramTypes)").slice(0,4)`
4. Either update `KNOWN_SELECTORS` in `conway.ts` or use the inline keccak fallback

### Transactions failing with "insufficient funds"

The agent's Base wallet needs ETH to pay gas. The funding you sent when creating it via Own Robot might have all gone to the Conway contract. Check:

```bash
curl https://nwo-agent-runner.your-subdomain.workers.dev/status | jq .agent_eth_balance_wei
```

If the agent has <0.001 ETH, send a small top-up from MetaMask to cover gas. The agent's operational balance (30% of earnings) will restore this over time once it's earning.

### Kimi returns non-JSON

Kimi K2.6 occasionally wraps JSON in markdown fences despite instructions. The parser in `reasoning.ts` handles this but if you see "Kimi response not parseable JSON" errors, check logs — you may need to tune the temperature down further or add stronger JSON schema language to the system prompt.

## Development loop

```bash
# Local dev (simulates cron, uses real bindings)
npx wrangler dev

# Typecheck before deploying
npm run typecheck

# Deploy updates
npx wrangler deploy

# Watch logs
npx wrangler tail
```

## What's NOT yet included

- GitHub repo creation (the agent can decide to do this, but `github.ts` module with Octokit isn't built yet)
- HF Space creation (same — mentioned in genesis but no module yet)
- Agent spawning children (needs `spawnChild` flow + child-genesis propagation)
- Autonomous purchase of API credits via `purchaseAPITier` (stub exists but needs proper tier-price verification)

These are additive modules you can build as the agent matures. The coordinator is structured to make adding them straightforward — each is a new `CycleAction` kind.

## License

MIT. Part of the NWO Robotics ecosystem.
