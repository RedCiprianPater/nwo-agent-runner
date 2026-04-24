/**
 * TimesFM + EML client.
 *
 * Queries nwo-timesfm.onrender.com for time-series forecasts.
 * Applies EML (e^x - ln(y)) operator to extract symbolic laws from residuals.
 */

import type { Env } from "./types";

interface TimesFMQuery {
  series_name: string;
  horizon_days: number;
  history_days?: number;
}

interface TimesFMResult {
  series: string;
  forecast: number[];
  summary: string;
  eml_law?: string;
}

export async function queryTimesFM(q: TimesFMQuery, env: Env): Promise<TimesFMResult> {
  try {
    const resp = await fetch(`${env.TIMESFM_URL}/forecast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        series: q.series_name,
        horizon: q.horizon_days,
        history: q.history_days || 90,
      }),
    });

    if (!resp.ok) {
      throw new Error(`TimesFM returned ${resp.status}: ${await resp.text()}`);
    }

    const data = await resp.json() as any;

    return {
      series: q.series_name,
      forecast: data.forecast || [],
      summary: data.summary ||
        `${q.horizon_days}-day forecast for ${q.series_name}: ` +
        `mean=${mean(data.forecast)?.toFixed(3) || "?"}`,
      eml_law: data.eml_law,
    };
  } catch (err) {
    console.warn("[timesfm] query failed:", err);
    return {
      series: q.series_name,
      forecast: [],
      summary: `TimesFM unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function mean(arr: number[]): number | undefined {
  if (!arr || arr.length === 0) return undefined;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
