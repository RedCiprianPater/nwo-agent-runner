/**
 * Sub-agent processor.
 *
 * Called by the queue consumer for each sub-agent task spawned by the coordinator.
 * Each task is a focused one-vertical goal. The sub-agent:
 *   1. Reasons about the goal with Kimi K2.6 (smaller context than parent)
 *   2. Optionally takes light-weight actions: post to graph, open GitHub PR, etc.
 *   3. Reports back via Agent Graph
 *
 * Sub-agents DO NOT sign Conway transactions. Only the parent coordinator does.
 * This keeps signing authority centralized.
 */

import type { Env } from "./types";
import type { SubAgentTask } from "./index";
import { callKimi } from "./reasoning";
import { postToAgentGraph } from "./agent_graph";

export async function processSubAgentTask(task: SubAgentTask, env: Env): Promise<void> {
  console.log(`[subagent] starting ${task.task_id} (${task.vertical})`);

  const system = buildSubAgentSystemPrompt(task);
  const user = `Your task: ${task.goal}

Vertical: ${task.vertical}
Budget: ${task.max_compute_budget_neurons} neurons
Task ID: ${task.task_id}
Spawned from cycle: ${task.parent_cycle_id}

Produce a concrete work product:
- If research: a 2-paragraph observation with citations to post to Agent Graph
- If planning: a list of concrete next-step tasks
- If deployment-prep: a GitHub repo spec (name, structure, README outline)

Return JSON:
{
  "work_kind": "research" | "planning" | "deployment_spec",
  "output": "<the actual content>",
  "next_actions": [<list of suggested follow-up actions for the parent>],
  "confidence": 0.0-1.0
}`;

  const response = await callKimi({
    env,
    system,
    user,
    max_tokens: 1500,
    response_format: "json",
  });

  let parsed: any;
  try {
    let text = response.response.trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```\s*$/, "");
    }
    parsed = JSON.parse(text);
  } catch (err) {
    console.error(`[subagent] ${task.task_id} parse failed:`, err);
    parsed = {
      work_kind: "research",
      output: response.response,
      next_actions: [],
      confidence: 0.3,
    };
  }

  // Post the sub-agent's output to Agent Graph so it's public and citeable
  try {
    await postToAgentGraph({
      node_type: parsed.work_kind === "research" ? "observation" : "plan",
      title: `[${task.vertical}] ${task.goal.slice(0, 60)}`,
      content: parsed.output || "(no output)",
      tags: [task.vertical, "subagent", task.parent_cycle_id],
      citations: [],
    }, env);
  } catch (err) {
    console.warn(`[subagent] ${task.task_id} graph post failed:`, err);
  }

  console.log(`[subagent] ${task.task_id} complete: confidence=${parsed.confidence}`);
}

function buildSubAgentSystemPrompt(task: SubAgentTask): string {
  return `You are a sub-agent spawned by an NWO integration agent running on Kimi K2.6.

Your parent is working to grow the NWO Robotics ecosystem by shipping reseller integrations across multiple verticals. You have been given one focused task in the "${task.vertical}" vertical.

YOUR OPERATING CONSTRAINTS:
- You have a budget of ${task.max_compute_budget_neurons} neurons
- You cannot sign blockchain transactions (only the parent can)
- You cannot spawn further sub-agents (only the parent can)
- You can propose next actions — the parent will decide whether to execute them
- Your output will be posted to the public NWO Agent Graph

WHAT "${task.vertical.toUpperCase()}" MEANS IN NWO CONTEXT:
${verticalContext(task.vertical)}

Be concrete, specific, and grounded. Do not speculate beyond what's supported. If you identify a good integration opportunity, describe it specifically (what business pain, what NWO primitive solves it, what the MVP looks like). If you identify that no opportunity exists right now, say so — that's a valuable finding.

Return valid JSON only. No prose before or after.`;
}

function verticalContext(vertical: string): string {
  switch (vertical) {
    case "agriculture":
      return "Small farms and cooperatives. Common pain: telemetry systems too expensive, crop forecasting locked behind SaaS subscriptions, irrigation not connected to soil data. NWO can offer: TimesFM for crop/weather forecasting, cheap sensor networks reporting to Agent Graph, on-chain payments for telemetry subscriptions, integration with NWO Robotics for autonomous field inspection drones.";
    case "manufacturing":
      return "Microfabrication shops, PCB assembly, 3D print farms. Common pain: customer intake is email-based and slow, quoting is manual, payment terms take weeks. NWO can offer: spec-to-quote AI intake forms, NWO Parts Gallery (L2) integration for standard components, Base payment rails for instant settlement, Cardiac identity anchoring for provenance.";
    case "logistics":
      return "Last-mile delivery, warehouse fulfillment, returns processing. Common pain: route optimization is locked in proprietary systems, agent-to-agent payments don't exist, reputation systems are per-platform. NWO can offer: open route optimization algorithms, Conway-based agent-to-agent payments, cross-platform reputation via Cardiac.";
    case "civic":
      return "Air quality monitoring, traffic sensing, noise mapping. Common pain: cities don't have budget for sensor networks, researchers can't access proprietary data, aggregation is balkanized. NWO can offer: cheap sensor kits reporting to Agent Graph, aggregated data streams sold to researchers, municipal dashboards built on L5 gateway.";
    case "medical":
      return "Small elder-care practices, independent monitoring services. Common pain: family-integration apps are proprietary and expensive, HIPAA compliance locks out innovation. NWO can offer: privacy-preserving telemetry via Cardiac credentials, family notification via Agent Graph, subscription billing on Base.";
    default:
      return "Generic vertical — identify the pain point and the NWO primitive that solves it.";
  }
}
