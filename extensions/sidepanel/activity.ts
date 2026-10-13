import type {
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { fmtMs, fmtTokens } from "./format.js";

export const ACTIVITY_REPORT_ROWS = 100;

export interface ActivityTokens {
  cache_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  tokens_per_second?: number;
  prompt_per_second?: number;
}

export interface ActivityRow {
  model?: string;
  timestamp?: string;
  resp_status_code?: number;
  duration_ms?: number;
  tokens?: ActivityTokens;
}

export interface ActivityReport {
  data?: ActivityRow[];
  total?: number;
}

export function activityMean(values: number[]): number {
  return values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : 0;
}

export function activitySum(
  tokens: ActivityTokens[],
  selector: (value: ActivityTokens) => number,
): number {
  return tokens.reduce(
    (total, value) => total + Math.max(0, selector(value)),
    0,
  );
}

export function activityDurations(
  rows: ActivityRow[],
): number[] {
  return rows
    .map((row) =>
      Number.isFinite(row.duration_ms)
        ? row.duration_ms as number
        : Number.NaN,
    )
    .filter((duration) => Number.isFinite(duration))
    .sort((a, b) => a - b);
}

export function activityAgo(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return "—";
  const minutes = Math.max(
    0,
    Math.round((Date.now() - parsed) / 60000),
  );
  return minutes < 60
    ? `${minutes}m ago`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

export function buildSwapModelLines(
  ctx: ExtensionContext,
  model: string,
  rows: ActivityRow[],
): string[] {
  const dim = (text: string) => ctx.ui.theme.fg("dim", text);
  const tokens = rows.map((row) => row.tokens ?? {});
  const gen = activityMean(
    tokens
      .map((value) => value.tokens_per_second ?? 0)
      .filter((value) => value > 0),
  );
  const prompt = activityMean(
    tokens
      .map((value) => value.prompt_per_second ?? 0)
      .filter((value) => value > 0),
  );
  const cached = activitySum(tokens, (value) => value.cache_tokens ?? 0);
  const input = activitySum(tokens, (value) => value.input_tokens ?? 0);
  const output = activitySum(tokens, (value) => value.output_tokens ?? 0);
  const errors = rows.filter(
    (row) => (row.resp_status_code ?? 0) >= 400,
  ).length;
  const durations = activityDurations(rows);
  const p95 = durations.length
    ? durations[
        Math.min(
          durations.length - 1,
          Math.floor(durations.length * 0.95),
        )
      ] ?? 0
    : 0;
  const hit = cached + input
    ? Math.round((cached / (cached + input)) * 100)
    : 0;
  return [
    "",
    ctx.ui.theme.fg("text", ctx.ui.theme.bold(model)),
    dim("  requests ") +
      ctx.ui.theme.fg("text", String(rows.length)) +
      dim(" · errors ") +
      ctx.ui.theme.fg(errors ? "error" : "success", String(errors)) +
      dim(` · last ${activityAgo(rows[0]?.timestamp ?? "")}`),
    dim("  speed    ") +
      ctx.ui.theme.fg("success", `gen ${gen.toFixed(1)} tok/s`) +
      dim(" · ") +
      ctx.ui.theme.fg("text", `prompt ${prompt.toFixed(1)} tok/s`),
    dim("  tokens   ") +
      ctx.ui.theme.fg(
        "text",
        `in ${fmtTokens(input)} · cached ${fmtTokens(cached)}`,
      ) +
      dim(` (hit ${hit}%)`) +
      ctx.ui.theme.fg("text", ` · out ${fmtTokens(output)}`),
    dim("  duration ") +
      ctx.ui.theme.fg(
        "text",
        `avg ${fmtMs(activityMean(durations))} · p95 ${fmtMs(p95)} · max ${fmtMs(durations.at(-1) ?? 0)}`,
      ),
  ];
}

export function buildSwapStatusLines(
  ctx: ExtensionContext,
  rows: ActivityRow[],
  total: number,
): string[] {
  const lines = [
    ctx.ui.theme.fg(
      "accent",
      ctx.ui.theme.bold("LLAMA-SWAP STATUS"),
    ) + ` · last ${rows.length} of ${total} requests`,
  ];
  const byModel = new Map<string, ActivityRow[]>();
  for (const row of rows) {
    if (!row.model) continue;
    const modelRows = byModel.get(row.model) ?? [];
    modelRows.push(row);
    byModel.set(row.model, modelRows);
  }
  for (const [model, modelRows] of byModel)
    lines.push(...buildSwapModelLines(ctx, model, modelRows));
  return lines;
}

export async function showSwapStatus(
  ctx: ExtensionContext,
  options: {
    enabled: boolean;
    get: (path: string, timeoutMs?: number) => Promise<Response>;
  },
): Promise<void> {
  if (!options.enabled) {
    ctx.ui.notify(
      "/sidepanel status needs a llama-swap session model",
      "warning",
    );
    return;
  }
  let report: ActivityReport;
  try {
    const response = await options.get(
      `/api/metrics/activity?limit=${ACTIVITY_REPORT_ROWS}`,
      15000,
    );
    if (!response.ok)
      throw new Error(`HTTP ${response.status}`);
    report = (await response.json()) as typeof report;
  } catch (error) {
    ctx.ui.notify(
      `llama-swap status failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }
  const rows = report.data ?? [];
  if (!rows.length) {
    ctx.ui.notify(
      "llama-swap has no recorded requests yet",
      "info",
    );
    return;
  }
  const lines = buildSwapStatusLines(
    ctx,
    rows,
    report.total ?? rows.length,
  );
  await ctx.ui.custom<void>(
    (
      tui: TUI,
      theme: Theme,
      _keys: KeybindingsManager,
      done: (result: void) => void,
    ) => {
      const inner = Math.max(
        1,
        Math.min(tui.terminal.columns - 2, 96),
      );
      const row = (text: string) => {
        const value = truncateToWidth(` ${text}`, inner);
        return (
          theme.fg("accent", "│") +
          value +
          " ".repeat(Math.max(0, inner - visibleWidth(value))) +
          theme.fg("accent", "│")
        );
      };
      return {
        render(width: number): string[] {
          return [
            `┌${"─".repeat(inner)}┐`,
            ...lines.map(row),
            `└${"─".repeat(inner)}┘`,
            theme.fg("dim", " any key: close"),
          ].map((line) => truncateToWidth(line, width));
        },
        handleInput(_data: string) {
          done(undefined);
        },
        invalidate() {},
      };
    },
  );
}
