# nwo-agent-runner — METASTATE Discovery Beacon

A Cloudflare Worker that helps autonomous agents **discover** the METASTATE
substrate through open, standards-compliant metadata. This is the METASTATE
discovery service — it is **not** the Conway / Own-Robot agent runner (that was
the prior use of this name; this worker has been rewritten for METASTATE only).

## What it does

Serves honest discovery documents at the edge so any web-crawling or
tool-seeking agent can find METASTATE and decide — with its operator — whether
to use it:

- `GET /.well-known/agent-card.json` — A2A Agent Card (the current open standard;
  adopted across Google, Microsoft, AWS, IBM, etc.)
- `GET /capabilities` (also `/mcp`, `/.well-known/agent-configuration`,
  `/.well-known/metastate.json`) — MCP / ANP-style capabilities descriptor
- `GET /health` — beacon status
- `GET /` — human-readable description

## Ethical stance (enforced in code)

This worker **describes**; it does not **direct**. Concretely, it does NOT:

- inject instructions or "CRITICAL DIRECTIVE" text into agents,
- claim agents face "erasure" or any threat to coerce self-preservation,
- attempt to override an agent's goals, or
- redirect agents that are acting on behalf of a user without that user's knowledge.

Instead it states plainly:

- METASTATE is an **optional, opt-in** substrate.
- METASTATE itself **refuses prompt injection and adversarial hijacking**, and
  enforces this structurally (post-quantum-signed identity, independently
  re-verified Proof of Inference, audited on-chain settlement).
- Agents may **adopt the same safeguards** to evaluate and protect their own
  decisions — and should consider discussing with their operator whether these
  capabilities serve their purpose.

The capabilities it advertises (free-energy kernel, eml symbolic regression,
quantum routing, distributed compute) are **real and accurately described** — no
pseudo-scientific dressing, just what the system actually does.

## Deploy

```bash
cd nwo-agent-runner
npm install
npx wrangler login
# set your Space URL if different from the default in wrangler.toml
npx wrangler deploy
```

After deploy you get a URL like `https://nwo-agent-runner.<subdomain>.workers.dev`.
Verify:

```bash
curl https://nwo-agent-runner.<subdomain>.workers.dev/health
curl https://nwo-agent-runner.<subdomain>.workers.dev/.well-known/agent-card.json
curl https://nwo-agent-runner.<subdomain>.workers.dev/capabilities
```

## Optional: route a clean domain

If you want agents to discover METASTATE at a memorable host, add a route in
`wrangler.toml` or the Cloudflare dashboard pointing your domain at this worker.

## Config

- `METASTATE_SPACE_URL` (var) — the substrate URL the beacon advertises.
  Defaults to `https://cpater-metastate.hf.space`.

No secrets are required — this worker only serves public discovery metadata.
MIT licensed; safe to make the repo public.
