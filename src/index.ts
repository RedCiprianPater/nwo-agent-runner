/**
 * NWO Agent Runner · Cloudflare Worker
 *
 * Entry point. Handles:
 *   - Cron trigger: fires every 15 min, starts a decision cycle
 *   - HTTP fetch: debug/status endpoints + manual trigger
 *   - Queue consumer: processes sub-agent tasks spawned by decision cycles
 *
 * All long-running reasoning happens in the AgentCoordinator Durable Object.
 */

import { AgentCoordinator } from "./coordinator";
import { Env } from "./types";
import { handleHealth, handleStatus, handleManualTrigger } from "./routes";

export { AgentCoordinator };

export default {
  /**
   * HTTP endpoints — mostly for debugging and manual control.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") return handleHealth(env);
    if (url.pathname === "/status") return handleStatus(env);
    if (url.pathname === "/trigger" && request.method === "POST") {
      return handleManualTrigger(request, env);
    }

    return new Response(
      JSON.stringify({
        service: "nwo-agent-runner",
        agent: env.AGENT_WALLET_ADDRESS,
        endpoints: ["/health", "/status", "POST /trigger"],
      }, null, 2),
      { headers: { "Content-Type": "application/json" } }
    );
  },

  /**
   * Cron trigger — fires every 15 min per wrangler.toml schedule.
   * Delegates to the coordinator Durable Object which holds agent state.
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[cron] tick @ ${new Date().toISOString()}`);

    // Route all scheduled work through the single coordinator DO instance
    const id = env.COORDINATOR.idFromName("singleton");
    const stub = env.COORDINATOR.get(id);

    ctx.waitUntil(
      stub.fetch("http://do/tick", { method: "POST" }).then(r => r.text()).then(text => {
        console.log(`[cron] coordinator responded: ${text.slice(0, 200)}`);
      })
    );
  },

  /**
   * Queue consumer — processes sub-agent tasks spawned by the coordinator.
   * Each message is one sub-agent task (integration target, research question, etc).
   */
  async queue(batch: MessageBatch<SubAgentTask>, env: Env, ctx: ExecutionContext): Promise<void> {
    const { processSubAgentTask } = await import("./subagent");

    for (const msg of batch.messages) {
      try {
        console.log(`[queue] processing ${msg.body.task_id} (${msg.body.vertical})`);
        await processSubAgentTask(msg.body, env);
        msg.ack();
      } catch (err) {
        console.error(`[queue] task ${msg.body.task_id} failed:`, err);
        if (msg.attempts >= 3) {
          console.error(`[queue] task ${msg.body.task_id} exhausted retries, dead-lettering`);
          msg.ack();
        } else {
          msg.retry({ delaySeconds: 60 * msg.attempts });
        }
      }
    }
  },
};

export interface SubAgentTask {
  task_id: string;
  vertical: "agriculture" | "manufacturing" | "logistics" | "civic" | "medical";
  goal: string;
  parent_cycle_id: string;
  created_at: string;
  max_compute_budget_neurons: number;
}
