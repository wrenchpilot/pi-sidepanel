/**
 * Side Panel — a lightweight stats panel for the pi TUI.
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Api,
  AssistantMessage,
  Model,
} from "@earendil-works/pi-ai";
import type {
  AgentSettledEvent,
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
  MessageEndEvent,
  MessageStartEvent,
  MessageUpdateEvent,
  ModelSelectEvent,
  ProviderModelConfig,
  ReadonlyFooterDataProvider,
  SessionCompactEvent,
  SessionStartEvent,
  SessionTreeEvent,
  Theme,
  ThemeColor,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import type {
  Component,
  TUI,
} from "@earendil-works/pi-tui";
import {
  HStack,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

/* ──────────────────────────────────────────────────────── constants ── */

const PANEL_WIDTH = 34;
const MIN_PANEL_WIDTH = 28;
const MAX_PANEL_WIDTH = 72;
const FAIL_FLASH_MS = 2500;
const ONLINE_MS = 3000;
const LIVE_POLL_MS = 3000;
const LIVE_STALE_MS = 5000;
const BUSY_POLL_MS = 3000;
const IDLE_POLL_MS = 30000;
const SERVER_RATE_STALE_MS = 120000;
const TITLE_REFRESH_MS = 2000;
const LOAD_DEFAULT_MS = 60000;
const ACTIVITY_REPORT_ROWS = 100;

/* ── helpers ─────────────────────────────────────────────────── */

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtMs(ms: number): string {
  return ms < 1000
    ? `${Math.round(ms)}ms`
    : `${(ms / 1000).toFixed(1)}s`;
}

const secsSince = (t: number, now = Date.now()) =>
  Math.max(0, Math.floor((now - t) / 1000));

let sessionStart = Date.now();

function usageTone(
  percent: number,
): "success" | "warning" | "error" {
  if (percent >= 80) return "error";
  if (percent >= 50) return "warning";
  return "success";
}

function syncTone(
  percent: number,
): "success" | "warning" | "error" {
  if (percent >= 90) return "success";
  if (percent >= 70) return "warning";
  return "error";
}

function bar(
  theme: Theme,
  filled: number,
  total: number,
  tone: ThemeColor,
): string {
  const f = Math.max(0, Math.min(total, filled));
  return (
    theme.fg(tone, "▓".repeat(f)) +
    theme.fg("dim", "░".repeat(total - f))
  );
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | readonly JsonValue[];
type JsonObject = { [key: string]: JsonValue };
type WireValue =
  | object
  | string
  | number
  | boolean
  | null
  | undefined;

function decodeWireValue(
  value: WireValue,
): JsonValue | undefined {
  if (value === null) return null;
  if (Array.isArray(value)) {
    const decoded: JsonValue[] = [];
    for (const item of value) {
      const next = decodeWireValue(item as WireValue);
      if (next === undefined) return undefined;
      decoded.push(next);
    }
    return decoded;
  }
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object String]") return String(value);
  if (tag === "[object Number]") {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  if (tag === "[object Boolean]") return Boolean(value);
  if (tag !== "[object Object]") return undefined;
  const decoded: JsonObject = {};
  for (const [key, item] of Object.entries(
    value as { [key: string]: WireValue },
  )) {
    const next = decodeWireValue(item);
    if (next === undefined) return undefined;
    decoded[key] = next;
  }
  return decoded;
}

function jsonObject(
  value: JsonValue | undefined,
): JsonObject | undefined {
  if (
    value === null ||
    value === undefined ||
    Array.isArray(value) ||
    Object.prototype.toString.call(value) !==
      "[object Object]"
  )
    return undefined;
  return value as JsonObject;
}

function jsonString(
  value: JsonValue | undefined,
): string | undefined {
  return Object.prototype.toString.call(value) ===
    "[object String]"
    ? String(value)
    : undefined;
}

function jsonNumber(
  value: JsonValue | undefined,
): number | undefined {
  if (
    Object.prototype.toString.call(value) !==
    "[object Number]"
  )
    return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

interface PiLensFindingCounts {
  errors: number;
  warnings: number;
  info: number;
}

const piLensState = {
  currentFile: "",
  languages: new Set<string>(),
  files: new Map<string, PiLensFindingCounts>(),
};

function emptyPiLensCounts(): PiLensFindingCounts {
  return { errors: 0, warnings: 0, info: 0 };
}

function piLensFallbackSeverity(
  fallback: "error" | "warning" | "info",
): keyof PiLensFindingCounts {
  if (fallback === "error") return "errors";
  if (fallback === "warning") return "warnings";
  return "info";
}

function displayPath(target: string | undefined): string {
  if (!target) return "—";
  const home = homedir();
  if (target === home) return "~";
  if (
    target.startsWith(`${home}/`) ||
    target.startsWith(`${home}\\`)
  )
    return `~${target.slice(home.length)}`;
  return target;
}

function piLensLanguage(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (/\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/.test(lower))
    return "jsts";
  if (/\.json(?:c|5)?$/.test(lower)) return "json";
  return undefined;
}

function piLensEventPaths(data: JsonValue): string[] {
  const record = jsonObject(data);
  if (!record) return [];
  const paths: string[] = [];
  for (const key of ["filePath", "file_path", "path"]) {
    const path = jsonString(record[key]);
    if (path) paths.push(path);
  }
  for (const key of ["paths", "files", "changedFiles"]) {
    const values = record[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const path = jsonString(value) ??
        jsonString(jsonObject(value)?.path);
      if (path) paths.push(path);
    }
  }
  return paths;
}

function piLensFindingPath(
  value: JsonValue,
): string | undefined {
  const record = jsonObject(value);
  if (!record) return undefined;
  for (const key of ["filePath", "file_path", "path", "file"]) {
    const path = jsonString(record[key]);
    if (path) return path;
  }
  return undefined;
}

function piLensFindingSeverity(
  value: JsonValue,
  fallback: "error" | "warning" | "info",
): keyof PiLensFindingCounts {
  const record = jsonObject(value);
  if (!record) return piLensFallbackSeverity(fallback);
  const raw = [
    record.severity,
    record.level,
    record.semantic,
    record.kind,
    record.type,
  ].map(jsonString).find(Boolean);
  const text = raw?.toLowerCase() ?? "";
  if (text.includes("error") || text.includes("block"))
    return "errors";
  if (text.includes("warn")) return "warnings";
  if (text.includes("info") || text.includes("hint"))
    return "info";
  return piLensFallbackSeverity(fallback);
}

function rememberPiLensEvent(data: JsonValue): void {
  const paths = piLensEventPaths(data);
  for (const path of paths) {
    piLensState.currentFile = path;
    const language = piLensLanguage(path);
    if (language) piLensState.languages.add(language);
  }
  const record = jsonObject(data);
  if (!record) return;
  const primaryPath =
    jsonString(record.filePath) ?? paths[0];
  const grouped = new Map<string, PiLensFindingCounts>();

  const addFinding = (
    finding: JsonValue,
    fallback: "error" | "warning" | "info",
    fallbackPath = primaryPath,
  ): void => {
    const path = piLensFindingPath(finding) ?? fallbackPath;
    if (!path) return;
    const counts = grouped.get(path) ?? emptyPiLensCounts();
    counts[piLensFindingSeverity(finding, fallback)]++;
    grouped.set(path, counts);
    piLensState.currentFile = path;
    const language = piLensLanguage(path);
    if (language) piLensState.languages.add(language);
  };

  const fileEntries = Array.isArray(record.files)
    ? record.files
    : [];
  for (const value of fileEntries) {
    const entry = jsonObject(value);
    if (!entry) continue;
    const path = piLensFindingPath(entry);
    if (!path) continue;
    const diagnostics = Array.isArray(entry.diagnostics)
      ? entry.diagnostics
      : [];
    if (!diagnostics.length) {
      grouped.set(path, emptyPiLensCounts());
      continue;
    }
    for (const finding of diagnostics)
      addFinding(finding, "info", path);
  }

  const diagnostics = Array.isArray(record.diagnostics)
    ? record.diagnostics
    : undefined;
  const findings = Array.isArray(record.findings)
    ? record.findings
    : undefined;
  if (diagnostics?.length) {
    for (const finding of diagnostics)
      addFinding(finding, "info");
  } else if (findings?.length) {
    for (const finding of findings)
      addFinding(finding, "info");
  } else {
    const blockers = Array.isArray(record.blockers)
      ? record.blockers
      : [];
    const warnings = Array.isArray(record.warnings)
      ? record.warnings
      : [];
    for (const finding of blockers)
      addFinding(finding, "error");
    for (const finding of warnings)
      addFinding(finding, "warning");
  }

  let explicitErrors = jsonNumber(record.errorCount);
  if (explicitErrors === undefined)
    explicitErrors = jsonNumber(record.errors);
  let explicitWarnings = jsonNumber(record.warningCount);
  if (explicitWarnings === undefined)
    explicitWarnings = jsonNumber(record.warnings);
  if (
    !grouped.size &&
    primaryPath &&
    (explicitErrors !== undefined ||
      explicitWarnings !== undefined)
  ) {
    grouped.set(primaryPath, {
      errors: Math.max(0, explicitErrors ?? 0),
      warnings: Math.max(0, explicitWarnings ?? 0),
      info: 0,
    });
  }

  const hasSnapshot =
    fileEntries.length > 0 ||
    diagnostics !== undefined ||
    findings !== undefined ||
    Array.isArray(record.blockers) ||
    Array.isArray(record.warnings);
  if (!grouped.size && hasSnapshot && primaryPath)
    grouped.set(primaryPath, emptyPiLensCounts());

  for (const [path, counts] of grouped) {
    if (counts.errors || counts.warnings || counts.info)
      piLensState.files.set(path, counts);
    else piLensState.files.delete(path);
  }
}

function truncateTo(
  target: string | undefined,
  maxLen: number,
): string {
  if (!target) return "—";
  return truncateToWidth(target, maxLen);
}

function clampPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return PANEL_WIDTH;
  return Math.min(
    MAX_PANEL_WIDTH,
    Math.max(MIN_PANEL_WIDTH, Math.round(width)),
  );
}

function finiteNumber(
  value: number | undefined,
): value is number {
  return value !== undefined && Number.isFinite(value);
}

function nonNegativeNumber(
  value: number | undefined,
): number | undefined {
  return finiteNumber(value) && value >= 0
    ? value
    : undefined;
}

/* ──────────────────────────────────────────────────────── live state ── */

type Phase = "idle" | "thinking" | "responding" | "tool";

const state = {
  phase: "idle" as Phase,
  phaseSince: Date.now(),
  toolName: "",
  toolTarget: "",
  turns: 0,
  toolOk: 0,
  toolFail: 0,
  runStart: 0,
  lastRunMs: 0,
  compacting: false,
  compactSince: 0,
  compactBy: "",
  hasSmartCompact: false,
  pruned: 0,
  thinkCuts: 0,
  lastFailAt: 0,
  lastFailTool: "",
  lastFailTarget: "",
};

function setPhase(p: Phase): void {
  if (state.phase === p) return;
  state.phase = p;
  state.phaseSince = Date.now();
}

function syncPercent(): number | null {
  const done = state.toolOk + state.toolFail;
  return done ? (state.toolOk / done) * 100 : null;
}

function animating(now = Date.now()): boolean {
  return (
    state.phase !== "idle" ||
    swap.state === "checking" ||
    swap.state === "loading" ||
    (swap.state === "ready" &&
      now - swap.since < ONLINE_MS) ||
    state.compacting ||
    now - state.lastFailAt < FAIL_FLASH_MS
  );
}

function toolTarget(args: JsonObject): string {
  const record = jsonObject(args);
  if (!record) return "";
  for (const key of [
    "path",
    "file_path",
    "filePath",
    "command",
    "cmd",
    "pattern",
    "query",
    "url",
  ]) {
    const value = jsonString(record[key]);
    if (value) return value.replace(/\s+/g, " ").trim();
  }
  for (const value of Object.values(record)) {
    const text = jsonString(value);
    if (text && text.length < 200)
      return text.replace(/\s+/g, " ").trim();
  }
  return "";
}

/* ── performance ── */

const MIN_PROMPT_SAMPLE_MS = 250;
const MAX_ESTIMATED_PROMPT_PPS = 1_000_000;

const perf = {
  start: 0,
  first: 0,
  chars: 0,
  livePromptTokens: 0,
  liveOutputTokens: 0,
  tps: 0,
  pps: 0,
  ttft: 0,
  lastMs: 0,
  peakTps: 0,
};

function liveTps(): number {
  if (state.phase !== "idle" && perf.first) {
    const s = (Date.now() - perf.first) / 1000;
    if (s > 0.3) {
      const outputTokens =
        perf.liveOutputTokens > 0
          ? perf.liveOutputTokens
          : perf.chars / 4;
      if (outputTokens > 0)
        return outputTokens / s;
    }
  }
  return perf.tps;
}

/* ── token totals ── */

interface TokenStats {
  input: number;
  output: number;
  cacheRead: number;
  cost: number;
}

const tokens: TokenStats = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cost: 0,
};

function countAssistant(m: AssistantMessage): void {
  tokens.input += m.usage?.input ?? 0;
  tokens.output += m.usage?.output ?? 0;
  tokens.cacheRead += m.usage?.cacheRead ?? 0;
  tokens.cost += m.usage?.cost?.total ?? 0;
}

function recountSession(ctx: ExtensionContext): void {
  Object.assign(tokens, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cost: 0,
  });
  state.thinkCuts = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      entry.type === "message" &&
      entry.message.role === "assistant"
    )
      countAssistant(entry.message as AssistantMessage);
  }
}

/* ── llama-swap monitor ── */

interface GpuStat {
  name: string;
  util: number;
  memUsed: number;
  memTotal: number;
  temp: number;
  power: number;
}

type SwapState =
  | "off"
  | "checking"
  | "loading"
  | "ready"
  | "asleep"
  | "error";

const swap = {
  kind: "" as "" | "llama-swap" | "ninfer",
  base: "",
  headers: {} as Record<string, string>,
  modelId: "",
  realId: "",
  state: "off" as SwapState,
  since: 0,
  loadMs: 0,
  expectedLoadMs: LOAD_DEFAULT_MS,
  error: "",
  gpus: [] as GpuStat[],
  ramUsed: 0,
  ramTotal: 0,
  srvTps: 0,
  srvTpsAt: 0,
  srvPps: 0,
  srvPpsAt: 0,
  cacheTokens: 0,
  inputTokens: 0,
  kvKnown: false,
  energyWh: 0,
  diskWh: 0,
  savedWh: 0,
  lastSampleAt: 0,
  lastWatts: 0,
};

const upstreamMetrics = {
  base: "",
  modelId: "",
  promptTokens: 0,
  promptSeconds: 0,
  outputTokens: 0,
  outputSeconds: 0,
  promptPps: 0,
  promptPpsAt: 0,
  tps: 0,
  tpsAt: 0,
};

let swapConnectionVersion = 0;

function isCurrentSwap(
  version: number,
  modelId: string,
  base: string,
): boolean {
  return (
    version === swapConnectionVersion &&
    swap.modelId === modelId &&
    swap.base === base
  );
}

function setSwapState(s: SwapState, error = ""): void {
  swap.state = s;
  swap.since = Date.now();
  swap.error = error;
}

function swapFetch(
  base: string,
  headers: Record<string, string>,
  path: string,
  timeoutMs = 5000,
): Promise<Response> {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return fetch(base.replace(/\/+$/, "") + suffix, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function swapGet(
  path: string,
  timeoutMs = 5000,
): Promise<Response> {
  return swapFetch(
    swap.base,
    swap.headers,
    path,
    timeoutMs,
  );
}

function normalizeServiceBase(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function parsePrometheusSamples(
  text: string,
): Map<string, number> {
  const samples = new Map<string, number>();
  const pattern =
    /^\\s*([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\\{[^}]*\\})?\\s+([-+0-9.eE]+)(?:\\s+\\d+)?\\s*$/;
  for (const line of text.split("\\n")) {
    if (line.startsWith("#")) continue;
    const match = pattern.exec(line);
    if (!match) continue;
    const name = match[1];
    const value = Number(match[2]);
    if (!name || !Number.isFinite(value)) continue;
    samples.set(name, (samples.get(name) ?? 0) + value);
  }
  return samples;
}

function metricValue(
  samples: Map<string, number>,
  names: string[],
): number | undefined {
  for (const name of names) {
    const value = samples.get(name);
    if (value !== undefined) return value;
  }
  for (const [name, value] of samples) {
    if (names.some((suffix) => name.endsWith(suffix)))
      return value;
  }
  return undefined;
}

function resetUpstreamMetrics(): void {
  Object.assign(upstreamMetrics, {
    base: "",
    modelId: "",
    promptTokens: 0,
    promptSeconds: 0,
    outputTokens: 0,
    outputSeconds: 0,
    promptPps: 0,
    promptPpsAt: 0,
    tps: 0,
    tpsAt: 0,
  });
}

function parseUpstreamMetrics(
  text: string,
  base: string,
  modelId: string,
): void {
  const samples = parsePrometheusSamples(text);
  const promptTokens = metricValue(samples, [
    "llamacpp:prompt_tokens_total",
    "prompt_tokens_total",
  ]);
  const promptSeconds = metricValue(samples, [
    "llamacpp:prompt_seconds_total",
    "prompt_seconds_total",
  ]);
  const outputTokens = metricValue(samples, [
    "llamacpp:tokens_predicted_total",
    "tokens_predicted_total",
  ]);
  const outputSeconds = metricValue(samples, [
    "llamacpp:tokens_predicted_seconds_total",
    "tokens_predicted_seconds_total",
  ]);
  const directPps = metricValue(samples, [
    "llamacpp:prompt_tokens_seconds",
    "llamacpp:prompt_per_second",
    "prompt_tokens_seconds",
    "prompt_per_second",
    "prompt_tokens_per_second",
  ]);
  const directTps = metricValue(samples, [
    "llamacpp:predicted_tokens_seconds",
    "llamacpp:tokens_per_second",
    "predicted_tokens_seconds",
    "tokens_per_second",
    "predicted_per_second",
  ]);
  const baselineReady =
    upstreamMetrics.base === base &&
    upstreamMetrics.modelId === modelId;
  if (!baselineReady) {
    resetUpstreamMetrics();
    upstreamMetrics.base = base;
    upstreamMetrics.modelId = modelId;
  }
  const now = Date.now();
  if (
    typeof directPps === "number" &&
    Number.isFinite(directPps) &&
    directPps > 0
  ) {
    upstreamMetrics.promptPps = directPps;
    upstreamMetrics.promptPpsAt = now;
  } else if (
    baselineReady &&
    promptTokens !== undefined &&
    promptSeconds !== undefined &&
    promptTokens >= upstreamMetrics.promptTokens &&
    promptSeconds > upstreamMetrics.promptSeconds
  ) {
    const tokenDelta = promptTokens - upstreamMetrics.promptTokens;
    const secondsDelta =
      promptSeconds - upstreamMetrics.promptSeconds;
    if (tokenDelta > 0 && secondsDelta > 0) {
      upstreamMetrics.promptPps = tokenDelta / secondsDelta;
      upstreamMetrics.promptPpsAt = now;
    }
  }
  if (
    typeof directTps === "number" &&
    Number.isFinite(directTps) &&
    directTps > 0
  ) {
    upstreamMetrics.tps = directTps;
    upstreamMetrics.tpsAt = now;
  } else if (
    baselineReady &&
    outputTokens !== undefined &&
    outputSeconds !== undefined &&
    outputTokens >= upstreamMetrics.outputTokens &&
    outputSeconds > upstreamMetrics.outputSeconds
  ) {
    const tokenDelta = outputTokens - upstreamMetrics.outputTokens;
    const secondsDelta =
      outputSeconds - upstreamMetrics.outputSeconds;
    if (tokenDelta > 0 && secondsDelta > 0) {
      upstreamMetrics.tps = tokenDelta / secondsDelta;
      upstreamMetrics.tpsAt = now;
    }
  }
  if (promptTokens !== undefined)
    upstreamMetrics.promptTokens = promptTokens;
  if (promptSeconds !== undefined)
    upstreamMetrics.promptSeconds = promptSeconds;
  if (outputTokens !== undefined)
    upstreamMetrics.outputTokens = outputTokens;
  if (outputSeconds !== undefined)
    upstreamMetrics.outputSeconds = outputSeconds;
}

async function refreshUpstreamMetrics(): Promise<void> {
  if (swap.kind !== "llama-swap") return;
  const version = swapConnectionVersion;
  const modelId = swap.modelId;
  const realId = swap.realId;
  const base = swap.base;
  const headers = { ...swap.headers };
  if (!base || !realId) return;
  try {
    const response = await swapFetch(
      base,
      headers,
      `/upstream/${encodeURIComponent(realId)}/metrics?model=${encodeURIComponent(realId)}`,
    );
    if (!response.ok) return;
    const text = await response.text();
    if (
      !isCurrentSwap(version, modelId, base) ||
      swap.realId !== realId
    )
      return;
    parseUpstreamMetrics(text, base, realId);
  } catch {
    // model metrics are optional
  }
}

function parseSwapMetrics(text: string): void {
  const gpus = new Map<string, GpuStat>();
  let ramUsed = 0;
  let ramTotal = 0;
  let srvTps = 0;
  let srvPps = 0;
  let cacheTokens = 0;
  let promptTokens = 0;
  let hasCacheTokens = false;
  let hasPromptTokens = false;

  for (const line of text.split("\n")) {
    const m =
      /^(?:llamaswap|ninfer)_([a-z_]+)(?:\{([^}]*)\})?\s+(\S+)$/.exec(
        line,
      );
    if (!m) continue;
    const key = m[1];
    if (!key) continue;
    const value = Number(m[3]);
    if (!Number.isFinite(value)) continue;
    const labels = m[2] ?? "";
    const metricModel = /(?:model|model_id|model_name)="([^"]*)"/.exec(
      labels,
    )?.[1];
    const metricMatchesModel =
      !metricModel ||
      metricModel === swap.realId ||
      metricModel === swap.modelId;
    if (key === "memory_used_bytes") ramUsed = value;
    else if (key === "memory_total_bytes") ramTotal = value;
    else if (
      key === "last_tokens_per_second" &&
      metricMatchesModel
    )
      srvTps = Math.max(0, value);
    else if (
      key === "last_prompt_per_second" &&
      metricMatchesModel
    )
      srvPps = Math.max(0, value);
    else if (
      key === "last_cache_tokens" &&
      metricMatchesModel
    ) {
      cacheTokens = Math.max(0, value);
      hasCacheTokens = true;
    } else if (
      key === "last_prompt_tokens" &&
      metricMatchesModel
    ) {
      promptTokens = Math.max(0, value);
      hasPromptTokens = true;
    }
    if (!key.startsWith("gpu_")) continue;
    const id = /id="([^"]*)"/.exec(labels)?.[1] ?? "0";
    const gpu = gpus.get(id) ?? {
      name: /name="([^"]*)"/.exec(labels)?.[1] ?? "GPU",
      util: 0,
      memUsed: 0,
      memTotal: 0,
      temp: 0,
      power: 0,
    };
    if (key === "gpu_util_percent") gpu.util = value;
    else if (key === "gpu_memory_used_bytes")
      gpu.memUsed = value;
    else if (key === "gpu_memory_total_bytes")
      gpu.memTotal = value;
    else if (key === "gpu_temperature_celsius")
      gpu.temp = value;
    else if (key === "gpu_power_draw_watts")
      gpu.power = value;
    gpus.set(id, gpu);
  }

  // Replace instantaneous metrics, but retain the last valid throughput
  // measurement when the server reports zero or omits it between requests.
  swap.ramUsed = ramUsed;
  swap.ramTotal = ramTotal;
  if (srvTps > 0) {
    swap.srvTps = srvTps;
    swap.srvTpsAt = Date.now();
  }
  if (srvPps > 0) {
    swap.srvPps = srvPps;
    swap.srvPpsAt = Date.now();
  }
  if (hasCacheTokens || hasPromptTokens) {
    const nextCache = hasCacheTokens
      ? cacheTokens
      : swap.cacheTokens;
    swap.cacheTokens = nextCache;
    if (hasPromptTokens)
      swap.inputTokens = Math.max(
        0,
        promptTokens - nextCache,
      );
    swap.kvKnown = true;
  }
  swap.gpus = [...gpus.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, g]) => g);
}

function sampleEnergy(now = Date.now()): void {
  const watts = swap.gpus.reduce(
    (sum, g) => sum + Math.max(0, g.power),
    0,
  );
  if (swap.lastSampleAt) {
    const dtH =
      Math.max(0, Math.min(60000, now - swap.lastSampleAt)) /
      3600000;
    swap.energyWh += ((swap.lastWatts + watts) / 2) * dtH;
  }
  swap.lastSampleAt = now;
  // Keep the previous sample for the trapezoidal integration above.
  swap.lastWatts = watts;
  persistEnergy();
}

function totalWh(): number {
  return swap.diskWh + swap.energyWh - swap.savedWh;
}

const ENERGY_SAVE_MS = 60000;
let lastPersistAt = 0;

function persistEnergy(force = false): void {
  const delta = swap.energyWh - swap.savedWh;
  if (
    delta <= 0 ||
    (!force && Date.now() - lastPersistAt < ENERGY_SAVE_MS)
  )
    return;
  lastPersistAt = Date.now();
  const cfg = loadSidepanelConfig();
  cfg.totalWh =
    (nonNegativeNumber(cfg.totalWh) ?? 0) + delta;
  try {
    saveSidepanelConfig(cfg);
  } catch {
    return;
  }
  swap.savedWh = swap.energyWh;
  swap.diskWh = cfg.totalWh;
}

async function refreshSwapMetrics(): Promise<void> {
  const version = swapConnectionVersion;
  const modelId = swap.modelId;
  const base = swap.base;
  const headers = { ...swap.headers };
  if (!base) return;
  try {
    const response = await swapFetch(base, headers, "/metrics");
    if (!response.ok) return;
    const text = await response.text();
    if (!isCurrentSwap(version, modelId, base)) return;
    parseSwapMetrics(text);
    sampleEnergy();
  } catch {
    // server unreachable: keep the last values
  }
}

async function refreshSwapRunning(): Promise<void> {
  if (swap.kind === "ninfer") return refreshNinferHealth();
  if (!swap.base || swap.state !== "ready") return;
  const version = swapConnectionVersion;
  const modelId = swap.modelId;
  const base = swap.base;
  const realId = swap.realId;
  const headers = { ...swap.headers };
  try {
    const response = await swapFetch(base, headers, "/running");
    if (!response.ok) return;
    const { running } = (await response.json()) as {
      running?: { model: string }[];
    };
    if (!isCurrentSwap(version, modelId, base)) return;
    if (!(running ?? []).some((r) => r.model === realId))
      setSwapState("asleep");
  } catch {
    // optional
  }
}

async function refreshNinferHealth(): Promise<void> {
  const version = swapConnectionVersion;
  const modelId = swap.modelId;
  const base = swap.base;
  const headers = { ...swap.headers };
  if (!base) return;
  try {
    const res = await swapFetch(
      base,
      headers,
      "/health",
      3000,
    );
    if (!isCurrentSwap(version, modelId, base)) return;
    if (res.ok) {
      if (swap.state !== "ready") setSwapState("ready");
    } else
      setSwapState("error", `health HTTP ${res.status}`);
  } catch (err) {
    if (isCurrentSwap(version, modelId, base))
      setSwapState(
        "error",
        err instanceof Error ? err.message : String(err),
      );
  }
}

async function refreshSwapActivity(): Promise<void> {
  if (swap.kind === "ninfer") return refreshSwapMetrics();
  const version = swapConnectionVersion;
  const modelId = swap.modelId;
  const realId = swap.realId;
  const base = swap.base;
  const headers = { ...swap.headers };
  if (!base) return;
  try {
    const response = await swapFetch(
      base,
      headers,
      "/api/metrics/activity?limit=10",
    );
    if (!response.ok) return;
    const { data } = (await response.json()) as {
      data?: ActivityRow[];
    };
    if (
      !isCurrentSwap(version, modelId, base) ||
      swap.realId !== realId
    )
      return;

    const rows = data ?? [];
    const matchingRows = rows.filter(
      (row) =>
        row.model === realId || row.model === modelId,
    );
    let selectedRows = matchingRows;
    if (
      !selectedRows.length &&
      rows.length === 1 &&
      !rows[0]?.model
    )
      selectedRows = rows;
    if (!selectedRows.length) return;

    // Activity is used only for the latest request's cache counters. The
    // Prometheus /metrics endpoint is authoritative for server throughput;
    // averaging historical activity rows makes PROMPT/S and TOK/S wrong.
    const timestampOf = (row: ActivityRow): number => {
      const timestamp = row.timestamp
        ? Date.parse(row.timestamp)
        : Number.NaN;
      return Number.isFinite(timestamp) ? timestamp : 0;
    };
    const latestRow = [...selectedRows].sort(
      (a, b) => timestampOf(b) - timestampOf(a),
    )[0];
    const latest = latestRow?.tokens;
    if (!latest) return;
    let updated = false;
    if (finiteNumber(latest.cache_tokens)) {
      swap.cacheTokens = Math.max(
        0,
        latest.cache_tokens,
      );
      updated = true;
    }
    if (finiteNumber(latest.input_tokens)) {
      swap.inputTokens = Math.max(
        0,
        latest.input_tokens,
      );
      updated = true;
    }
    if (updated) swap.kvKnown = true;
  } catch {
    // metrics are optional
  }
}

/* ── live context ── */

interface SwapSlotTimings {
  prompt_n?: number;
  prompt_ms?: number;
  prompt_per_second?: number;
}

interface SwapSlot {
  is_processing?: boolean;
  n_prompt_tokens?: number;
  n_prompt_tokens_processed?: number;
  n_prompt_tokens_cache?: number;
  n_ctx?: number;
  progress?: number;
  next_token?: Array<{
    has_next_token?: boolean;
    n_remain?: number;
    n_decoded?: number;
  }>;
  timings?: SwapSlotTimings;
}

const live = {
  tokens: 0,
  at: 0,
  promptTokens: 0,
  promptAt: 0,
  promptPps: 0,
  promptPpsServer: false,
  promptTotal: 0,
  promptProcessed: 0,
  promptProgressKnown: false,
  promptTotalEstimated: false,
};

function resetSwapObservation(): void {
  resetUpstreamMetrics();
  swap.gpus = [];
  swap.ramUsed = 0;
  swap.ramTotal = 0;
  swap.srvTps = 0;
  swap.srvTpsAt = 0;
  swap.srvPps = 0;
  swap.srvPpsAt = 0;
  swap.cacheTokens = 0;
  swap.inputTokens = 0;
  swap.kvKnown = false;
  swap.loadMs = 0;
  swap.lastSampleAt = 0;
  swap.lastWatts = 0;
  live.tokens = 0;
  live.at = 0;
  live.promptTokens = 0;
  live.promptAt = 0;
  live.promptPps = 0;
  live.promptPpsServer = false;
  live.promptTotal = 0;
  live.promptProcessed = 0;
  live.promptProgressKnown = false;
  live.promptTotalEstimated = false;
}

function resetSessionState(): void {
  sessionStart = Date.now();
  swapConnectionVersion++;
  resetSwapObservation();
  Object.assign(state, {
    phase: "idle" as Phase,
    phaseSince: sessionStart,
    toolName: "",
    toolTarget: "",
    turns: 0,
    toolOk: 0,
    toolFail: 0,
    runStart: 0,
    lastRunMs: 0,
    compacting: false,
    compactSince: 0,
    compactBy: "",
    hasSmartCompact: false,
    pruned: 0,
    thinkCuts: 0,
    lastFailAt: 0,
    lastFailTool: "",
    lastFailTarget: "",
  });
  Object.assign(perf, {
    start: 0,
    first: 0,
    chars: 0,
    livePromptTokens: 0,
    liveOutputTokens: 0,
    tps: 0,
    pps: 0,
    ttft: 0,
    lastMs: 0,
    peakTps: 0,
  });
}

async function refreshLiveContext(): Promise<void> {
  if (swap.kind !== "llama-swap" || swap.state !== "ready")
    return;
  const version = swapConnectionVersion;
  const modelId = swap.modelId;
  const base = swap.base;
  const realId = swap.realId;
  const headers = { ...swap.headers };
  if (!base) return;
  try {
    const response = await swapFetch(
      base,
      headers,
      `/upstream/${encodeURIComponent(realId)}/slots?model=${encodeURIComponent(realId)}`,
      1500,
    );
    if (!response.ok) return;
    const slots = (await response.json()) as SwapSlot[];
    if (!isCurrentSwap(version, modelId, base)) return;
    const busy = slots.filter((slot) => {
      if (slot.is_processing !== true) return false;
      const processed = slot.n_prompt_tokens_processed;
      const total = slot.n_prompt_tokens;
      return (
        (finiteNumber(processed) && processed > 0) ||
        (finiteNumber(total) && total > 0)
      );
    });
    if (!busy.length) return;
    const progressOf = (slot: SwapSlot): number => {
      if (finiteNumber(slot.n_prompt_tokens_processed))
        return slot.n_prompt_tokens_processed;
      return slot.n_prompt_tokens ?? 0;
    };
    const now = Date.now();
    const activeSlot = busy.reduce((best, slot) =>
      progressOf(slot) > progressOf(best) ? slot : best,
    );
    const promptTokens = progressOf(activeSlot);
    const reportedProgress =
      finiteNumber(activeSlot.progress) &&
      activeSlot.progress > 0 &&
      activeSlot.progress <= 1
        ? activeSlot.progress
        : undefined;
    const slotTotal =
      finiteNumber(activeSlot.n_prompt_tokens) &&
      activeSlot.n_prompt_tokens > 0
        ? activeSlot.n_prompt_tokens
        : 0;
    const nRemain =
      activeSlot.next_token?.[0]?.n_remain;
    const promptBudget =
      finiteNumber(activeSlot.n_ctx) &&
      finiteNumber(nRemain) &&
      nRemain >= 0
        ? Math.max(0, activeSlot.n_ctx - nRemain)
        : 0;
    const contextTokens =
      liveCtx?.getContextUsage?.()?.tokens ?? undefined;
    let estimatedTotal = Math.max(
      slotTotal,
      promptBudget,
    );
    if (reportedProgress !== undefined)
      estimatedTotal = Math.ceil(
        promptTokens / reportedProgress,
      );
    else if (
      !estimatedTotal &&
      contextTokens !== undefined &&
      contextTokens > promptTokens
    )
      estimatedTotal = contextTokens;
    const generationStarted =
      activeSlot.next_token?.some(
        (token) =>
          finiteNumber(token.n_decoded) &&
          token.n_decoded > 0,
      ) ?? false;
    const promptFinished =
      generationStarted ||
      (promptBudget > 0
        ? promptTokens >= promptBudget
        : finiteNumber(activeSlot.n_prompt_tokens) &&
          finiteNumber(activeSlot.n_prompt_tokens_processed) &&
          activeSlot.n_prompt_tokens_processed >=
            activeSlot.n_prompt_tokens);
    live.promptTotal = promptFinished
      ? promptTokens
      : estimatedTotal;
    live.promptProcessed = promptTokens;
    live.promptProgressKnown = live.promptTotal > 0;
    live.promptTotalEstimated =
      !promptFinished &&
      reportedProgress === undefined &&
      promptBudget === 0 &&
      slotTotal === 0 &&
      estimatedTotal > 0;
    if (
      finiteNumber(activeSlot.n_prompt_tokens) &&
      finiteNumber(activeSlot.n_prompt_tokens_cache)
    ) {
      swap.cacheTokens = Math.max(
        0,
        activeSlot.n_prompt_tokens_cache,
      );
      swap.inputTokens = Math.max(
        0,
        activeSlot.n_prompt_tokens -
          activeSlot.n_prompt_tokens_cache,
      );
      swap.kvKnown = true;
    }
    const serverPps = activeSlot.timings?.prompt_per_second;
    const timingPromptN = activeSlot.timings?.prompt_n;
    const timingPromptMs = activeSlot.timings?.prompt_ms;
    if (!perf.first) {
      if (finiteNumber(serverPps) && serverPps > 0) {
        live.promptPps = serverPps;
        live.promptPpsServer = true;
      } else if (
        finiteNumber(timingPromptN) &&
        finiteNumber(timingPromptMs) &&
        timingPromptN > 0 &&
        timingPromptMs > 0
      ) {
        live.promptPps =
          timingPromptN / (timingPromptMs / 1000);
        live.promptPpsServer = true;
      } else if (
        live.promptAt &&
        promptTokens < live.promptTokens
      ) {
        // A new slot/request reset its processed-token counter.
        live.promptPps = 0;
        live.promptPpsServer = false;
      } else {
        // The slot exposes cumulative processed tokens, not elapsed timing.
        // Use the request start as the denominator; using the delta between
        // polls incorrectly turns a 2,048-token batch into ~680 tok/s.
        const elapsed = perf.start
          ? (now - perf.start) / 1000
          : 0;
        if (
          elapsed >= MIN_PROMPT_SAMPLE_MS / 1000 &&
          promptTokens > 0
        ) {
          live.promptPps = promptTokens / elapsed;
          live.promptPpsServer = false;
        }
      }
      live.promptTokens = promptTokens;
      live.promptAt = now;
    }
    live.tokens = finiteNumber(activeSlot.n_prompt_tokens)
      ? activeSlot.n_prompt_tokens
      : promptTokens;
    live.at = now;
  } catch {
    // the pi estimate stays
  }
}

function contextUsage():
  | {
      tokens: number | null;
      contextWindow: number;
      percent: number;
      live: boolean;
    }
  | undefined {
  const usage = liveCtx?.getContextUsage?.();
  if (!usage) return undefined;
  if (
    state.phase !== "idle" &&
    usage.contextWindow &&
    Date.now() - live.at < LIVE_STALE_MS
  ) {
    return {
      tokens: live.tokens,
      contextWindow: usage.contextWindow,
      percent: Math.min(
        100,
        (live.tokens / usage.contextWindow) * 100,
      ),
      live: true,
    };
  }
  return {
    tokens: usage.tokens,
    contextWindow: usage.contextWindow,
    percent: usage.percent ?? 0,
    live: false,
  };
}

/* ── swap connection ── */

async function connectSwap(
  ctx: ExtensionContext,
  model: Model<Api> | undefined,
): Promise<boolean> {
  const previousBase = swap.base;
  const previousKind = swap.kind;
  const previousModelId = swap.modelId;
  const version = ++swapConnectionVersion;
  if (
    !model ||
    (model.provider !== "llama-swap" &&
      model.provider !== "ninfer") ||
    !model.baseUrl
  ) {
    resetSwapObservation();
    swap.base = "";
    swap.headers = {};
    swap.kind = "";
    swap.modelId = "";
    swap.realId = "";
    setSwapState("off");
    return false;
  }
  swap.kind = model.provider;
  const id = model.id;
  swap.modelId = id;
  swap.realId = id;
  // Invalidate readers while credentials for the new connection are resolved.
  swap.base = "";
  swap.headers = {};
  setSwapState("checking");
  const auth = await ctx.modelRegistry
    .getApiKeyAndHeaders(model)
    .catch((err) => {
      if (version === swapConnectionVersion)
        setSwapState(
          "error",
          err instanceof Error ? err.message : String(err),
        );
      return undefined;
    });
  if (!auth || version !== swapConnectionVersion)
    return false;
  const base = normalizeServiceBase(model.baseUrl);
  const headers = Object.create(null) as Record<
    string,
    string
  >;
  if (auth.ok && auth.headers) {
    for (const [key, value] of Object.entries(
      auth.headers,
    )) {
      if (value !== null) headers[key] = value;
    }
  }
  if (auth.ok && auth.apiKey)
    headers.Authorization = `Bearer ${auth.apiKey}`;
  if (
    previousBase !== base ||
    previousKind !== model.provider ||
    previousModelId !== id
  )
    resetSwapObservation();
  swap.base = base;
  swap.headers = headers;
  void refreshSwapMetrics();
  void refreshUpstreamMetrics();
  void refreshSwapActivity();
  if (swap.kind === "ninfer") return true;
  // Use a snapshot: another model can be selected while the alias request is in flight.
  const get = (path: string) =>
    swapFetch(base, headers, path);
  const aliases = await swapAliases(get);
  if (
    version !== swapConnectionVersion ||
    swap.modelId !== id
  )
    return false;
  swap.realId = aliases.get(id) ?? id;
  void refreshSwapActivity();
  return true;
}

interface SwapModelInfo {
  id?: string;
  meta?: {
    llamaswap?: {
      type?: string;
      modelID?: string;
    };
  };
}

async function swapAliases(
  get: (path: string) => Promise<Response> = swapGet,
): Promise<Map<string, string>> {
  const aliases = new Map<string, string>();
  try {
    const response = await get("/v1/models");
    if (!response.ok) return aliases;
    const { data } = (await response.json()) as {
      data?: SwapModelInfo[];
    };
    for (const model of data ?? []) {
      if (!model.id) continue;
      const alias = model.meta?.llamaswap;
      aliases.set(
        model.id,
        alias?.type === "alias" && alias.modelID
          ? alias.modelID
          : model.id,
      );
    }
  } catch {
    // ids stay as they are
  }
  return aliases;
}

async function swapRunning(
  get: (path: string) => Promise<Response> = swapGet,
): Promise<Map<string, string>> {
  try {
    const response = await get("/running");
    if (!response.ok) return new Map();
    const { running } = (await response.json()) as {
      running?: { model: string; state: string }[];
    };
    return new Map(
      (running ?? []).map((r) => [r.model, r.state]),
    );
  } catch {
    return new Map();
  }
}

async function probeModel(
  ctx: ExtensionContext,
  model: Model<Api> | undefined = ctx.model,
): Promise<void> {
  if (!(await connectSwap(ctx, model)) || !model) return;
  if (swap.kind === "ninfer") return refreshNinferHealth();
  const version = swapConnectionVersion;
  const id = model.id;
  const realId = swap.realId;
  const base = swap.base;
  const headers = { ...swap.headers };
  const running = await swapRunning((path) =>
    swapFetch(base, headers, path),
  );
  const runningState = running.get(realId);
  if (isCurrentSwap(version, id, base))
    setSwapState(
      runningState === "ready" ? "ready" : "asleep",
    );
}

async function preloadModel(
  ctx: ExtensionContext,
  model: Model<Api> | undefined = ctx.model,
): Promise<void> {
  if (!(await connectSwap(ctx, model)) || !model) return;
  if (swap.kind === "ninfer") return refreshNinferHealth();
  const version = swapConnectionVersion;
  const id = model.id;
  const base = swap.base;
  const headers = { ...swap.headers };
  const realId = swap.realId;
  if (!isCurrentSwap(version, id, base)) return;
  swap.expectedLoadMs =
    nonNegativeNumber(loadSidepanelConfig().loads?.[realId]) ??
    LOAD_DEFAULT_MS;

  const slow = setTimeout(() => {
    if (
      isCurrentSwap(version, id, base) &&
      swap.state === "checking"
    )
      setSwapState("loading");
  }, Math.min(400, Math.max(100, Math.round(swap.expectedLoadMs / 4))));
  const started = Date.now();
  try {
    const res = await swapFetch(
      base,
      headers,
      `/upstream/${encodeURIComponent(id)}/health`,
      15 * 60000,
    );
    if (!isCurrentSwap(version, id, base)) return;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const loaded = swap.state === "loading";
    if (loaded) {
      swap.loadMs = Date.now() - started;
      const cfg = loadSidepanelConfig();
      try {
        saveSidepanelConfig({
          ...cfg,
          loads: { ...cfg.loads, [realId]: swap.loadMs },
        });
      } catch {
        // A read-only config must not make a healthy model look offline.
      }
    }
    setSwapState("ready");
  } catch (err) {
    if (isCurrentSwap(version, id, base))
      setSwapState(
        "error",
        err instanceof Error ? err.message : String(err),
      );
  } finally {
    clearTimeout(slow);
    if (isCurrentSwap(version, id, base)) {
      void refreshSwapMetrics();
      void refreshUpstreamMetrics();
    }
  }
}

/* ──────────────────────────────────────────────────────── side panel ── */

function panelPad(content: string, inner: number): string {
  const width = visibleWidth(content);
  if (width > inner) return truncateToWidth(content, inner);
  return content + " ".repeat(inner - width);
}

function panelFrame(
  panel: SidepanelPanel,
  content: string,
  inner: number,
): string {
  const border = (value: string) =>
    panel.theme.fg("border", value);
  return border("│") + panelPad(content, inner) + border("│");
}

function panelLabel(
  panel: SidepanelPanel,
  options: {
    inner: number;
    label: string;
    left: string;
    right: string;
    tone: ThemeColor;
  },
): string {
  const { inner, label, left, right, tone } = options;
  const border = (value: string) =>
    panel.theme.fg("border", value);
  const text = ` ${truncateToWidth(label, inner - 4)} `;
  const rest = Math.max(0, inner - visibleWidth(text) - 1);
  return (
    border(left + "─") +
    panel.theme.fg(tone, text) +
    border("─".repeat(rest) + right)
  );
}

function panelSep(
  panel: SidepanelPanel,
  inner: number,
  label: string,
): string {
  return panelLabel(panel, {
    inner,
    label,
    left: "├",
    right: "┤",
    tone: "muted",
  });
}

interface PanelFieldOptions {
  label: string;
  value: string;
  inner: number;
  tone?: ThemeColor;
}

function panelField(
  panel: SidepanelPanel,
  options: PanelFieldOptions,
): string {
  const {
    label,
    value,
    inner,
    tone = "text",
  } = options;
  const labelText = panel.theme.fg("dim", label.padEnd(9));
  return panelFrame(
    panel,
    " " + labelText + panel.theme.fg(tone, value),
    inner,
  );
}

function panelFieldRows(
  panel: SidepanelPanel,
  options: PanelFieldOptions,
): string[] {
  const width = Math.max(1, options.inner - 11);
  const lines = wrapTextWithAnsi(options.value, width);
  if (!lines.length) lines.push("");
  return lines.map((value, index) =>
    index === 0
      ? panelField(panel, { ...options, value })
      : panelFrame(panel, " ".repeat(10) + value, options.inner),
  );
}

function locationRows(
  panel: SidepanelPanel,
  inner: number,
): string[] {
  const out = [panelSep(panel, inner, "LOCATION")];
  out.push(
    ...panelFieldRows(panel, {
      label: "CWD",
      value: displayPath(liveCtx?.cwd),
      inner,
      tone: "text",
    }),
    ...panelFieldRows(panel, {
      label: "BRANCH",
      value: truncateTo(
        footerDataRef?.getGitBranch?.() ?? undefined,
        inner - 11,
      ),
      inner,
      tone: "muted",
    }),
  );
  return out;
}

function extensionRows(
  panel: SidepanelPanel,
  inner: number,
): string[] {
  const statuses = extensionStatusEntries().filter(
    ([key]) => !key.toLowerCase().startsWith("pi-lens"),
  );
  if (!statuses.length) return [];
  const out = [panelSep(panel, inner, "EXTENSIONS")];
  const valueWidth = Math.max(1, inner - 1);
  for (const [, value] of statuses) {
    const wrapped = wrapTextWithAnsi(value, valueWidth);
    for (const line of wrapped)
      out.push(panelFrame(panel, ` ${line}`, inner));
  }
  return out;
}

function sessionRows(
  panel: SidepanelPanel,
  inner: number,
  compact: boolean,
): string[] {
  const out = [panelSep(panel, inner, "SESSION")];
  const model = liveCtx?.model;
  out.push(
    panelField(panel, { label: "MODEL", value: truncateTo(model?.id, inner - 11), inner: inner, tone: "text" }),
  );
  if (!compact)
    out.push(
      panelField(panel, { label: "PROVIDER", value: truncateTo(String(model?.provider), inner - 11), inner: inner, tone: "muted" }),
    );
  out.push(
    panelField(panel, { label: "THINKING", value: liveCtx?.thinkingLevel ?? "off", inner: inner, tone: "muted" }),
  );
  return out;
}

function costRow(
  panel: SidepanelPanel,
  inner: number,
): string {
  if (!swap.gpus.length)
    return panelField(panel, { label: "COST", value: "—", inner: inner, tone: "muted" });
  const kwhPrice = ui.kwhPrice;
  if (kwhPrice === undefined)
    return panelField(panel, { label: "COST", value: "→ /sidepanel cost", inner: inner, tone: "dim" });
  const fmtMoney = (wh: number) => {
    const price = (wh / 1000) * kwhPrice;
    return ui.currency === "USD"
      ? `$${price.toFixed(3)}`
      : `${price.toFixed(3)} €`;
  };
  return panelField(panel, { label: "COST", value: fmtMoney(totalWh()) +
    panel.theme.fg("dim", ` (ses ${fmtMoney(swap.energyWh)})`), inner: inner, tone: "warning" });
}

function statusSection(
  panel: SidepanelPanel,
  inner: number,
): string[] {
  const th = panel.theme;
  const now = Date.now();
  const pulse = animating(now)
    ? th.fg("accent", "◈")
    : th.fg("dim", "○");
  const idle = state.phase === "idle";
  const fallen = now - state.lastFailAt < FAIL_FLASH_MS;
  let title: string;
  let titleTone: ThemeColor = "accent";
  let status: string;
  if (state.phase === "tool" || (idle && fallen)) {
    title = fallen
      ? `FAILED · ${state.lastFailTool}`
      : `${state.toolName || "tool"} · ${secsSince(state.phaseSince, now)}s`;
    titleTone = fallen ? "error" : "warning";
    const target =
      (fallen
        ? state.lastFailTarget || state.lastFailTool
        : state.toolTarget || state.toolName) || "tool";
    status = `${pulse} ${th.fg(fallen ? "error" : "text", truncateToWidth(target, inner - 4))}`;
  } else if (state.phase === "thinking") {
    title = `THINKING · ${secsSince(state.phaseSince, now)}s`;
    titleTone = "accent";
    status = `${pulse} deliberating`;
  } else if (state.phase === "responding") {
    const tps = liveTps();
    title = `RESPONDING${tps ? ` · ${tps.toFixed(1)} tok/s` : ""}`;
    titleTone = "success";
    status = `${pulse} streaming`;
  } else if (state.compacting) {
    title = `COMPACTING · ${state.compactBy || "context"} · ${secsSince(state.compactSince, now)}s`;
    titleTone = "warning";
    status = `${pulse} compacting context`;
  } else if (
    idle && (swap.state === "checking" || swap.state === "loading")
  ) {
    title = swap.state === "loading"
      ? `LOADING · ${secsSince(swap.since)}s`
      : "CHECKING";
    titleTone = "warning";
    status = `${pulse} loading model`;
  } else if (idle && swap.state === "error") {
    title = "OFFLINE";
    titleTone = "error";
    status = `${pulse} swap error`;
  } else if (idle && swap.state === "asleep") {
    title = "ASLEEP · type to wake";
    titleTone = "muted";
    status = `${pulse} model asleep`;
  } else if (
    idle && swap.state === "ready" &&
    now - swap.since < ONLINE_MS
  ) {
    title = swap.loadMs ? `ONLINE · ${fmtMs(swap.loadMs)}` : "ONLINE";
    titleTone = "success";
    status = `${pulse} model ready`;
  } else {
    title = "STANDBY";
    titleTone = "muted";
    status = `${pulse} at rest`;
  }
  return [
    panelLabel(panel, {
      inner,
      label: title,
      left: "┌",
      right: "┐",
      tone: titleTone,
    }),
    panelFrame(panel, status, inner),
  ];
}

function telemetryRows(
  panel: SidepanelPanel,
  inner: number,
  compact: boolean,
): string[] {
  const th = panel.theme;
  const out = [panelSep(panel, inner, "TELEMETRY")];
  if (!compact) {
    out.push(
      panelFrame(panel, ` ${th.fg("dim", "TURNS".padEnd(9))}${th.fg("text", String(state.turns))}`,
      inner,),
      panelFrame(panel, ` ${th.fg("dim", "TOKENS".padEnd(9))}${th.fg("success", "↑" + fmtTokens(tokens.input))} ${th.fg("warning", "↓" + fmtTokens(tokens.output))}`,
      inner,),
    );
    if (tokens.cacheRead)
      out.push(panelField(panel, { label: "CACHE", value: fmtTokens(tokens.cacheRead), inner: inner, tone: "muted" }));
    if (tokens.cost)
      out.push(panelField(panel, { label: "API COST", value: `$${tokens.cost.toFixed(3)}`, inner: inner, tone: "muted" }));
  }
  const sync = syncPercent();
  out.push(
    panelFrame(panel, sync === null
      ? ` ${th.fg("dim", "SYNC".padEnd(9))}${th.fg("dim", "— no tools")}`
      : ` ${th.fg("dim", "SYNC".padEnd(9))}${bar(th, Math.round(sync / 10), 10, syncTone(sync))} ${th.fg(syncTone(sync), `${sync.toFixed(0)}%`)}`,
    inner,),
    panelFrame(panel, ` ${th.fg("dim", "TOOLS".padEnd(9))}${th.fg("success", `✓${state.toolOk}`)}${th.fg("dim", " Success ")}${th.fg(state.toolFail ? "error" : "dim", `✗${state.toolFail}`)}${th.fg("dim", " Failed")}`,
    inner,),
  );
  const usage = contextUsage();
  const percent = usage?.percent ?? 0;
  const liveMark = usage?.live ? th.fg("accent", " ▲ live") : "";
  if (!compact && usage?.contextWindow)
    out.push(
      panelField(panel, { label: "CONTEXT", value: `${usage.tokens == null ? "?" : fmtTokens(usage.tokens)} / ${fmtTokens(usage.contextWindow)}`, inner: inner, tone: "muted" }),
    );
  out.push(
    panelFrame(panel, ` ${th.fg("dim", "WINDOW".padEnd(9))}${bar(th, Math.round(percent / 10), 10, usageTone(percent))} ${th.fg(usageTone(percent), `${percent.toFixed(0)}%`)}${liveMark}`,
    inner,),
  );
  if (!compact && (state.pruned || state.thinkCuts)) {
    const cuts = state.thinkCuts ? ` ✂${state.thinkCuts}` : "";
    out.push(
      panelField(panel, { label: "HYGIENE", value: `-${fmtTokens(state.pruned)}${cuts}`, inner: inner, tone: state.thinkCuts ? "warning" : "muted" }),
    );
  }
  return out;
}

function piLensRows(
  panel: SidepanelPanel,
  inner: number,
): string[] {
  const values = piLensStatusValues();
  const languages = [...piLensState.languages]
    .sort((a, b) => a.localeCompare(b))
    .join(" ");
  if (
    !values.length &&
    !languages &&
    !piLensState.currentFile &&
    !piLensState.files.size
  )
    return [];
  const out = [panelSep(panel, inner, "PI-LENS")];
  if (languages)
    out.push(
      ...panelFieldRows(panel, {
        label: "LANG",
        value: languages,
        inner,
        tone: "muted",
      }),
    );
  const files = [...piLensState.files.entries()].sort(
    ([a], [b]) => a.localeCompare(b),
  );
  const currentFileHasIssues = files.some(
    ([path]) =>
      path === piLensState.currentFile ||
      displayPath(path) === displayPath(piLensState.currentFile),
  );
  if (piLensState.currentFile && !currentFileHasIssues)
    out.push(
      ...panelFieldRows(panel, {
        label: "FILE",
        value: displayPath(piLensState.currentFile),
        inner,
        tone: "text",
      }),
    );
  if (files.length) {
    const totals = files.reduce(
      (sum, [, counts]) => ({
        errors: sum.errors + counts.errors,
        warnings: sum.warnings + counts.warnings,
        info: sum.info + counts.info,
      }),
      emptyPiLensCounts(),
    );
    const totalParts = [
      `${totals.errors} ${totals.errors === 1 ? "error" : "errors"}`,
      `${totals.warnings} ${totals.warnings === 1 ? "warning" : "warnings"}`,
    ];
    if (totals.info) totalParts.push(`${totals.info} info`);
    out.push(
      ...panelFieldRows(panel, {
        label: "ISSUES",
        value: `${files.length} ${files.length === 1 ? "file" : "files"} · ${totalParts.join(" · ")}`,
        inner,
        tone: totals.errors ? "error" : "warning",
      }),
    );
    for (const [path, counts] of files) {
      const parts: string[] = [];
      if (counts.errors) parts.push(`${counts.errors}E`);
      if (counts.warnings) parts.push(`${counts.warnings}W`);
      if (counts.info) parts.push(`${counts.info}I`);
      let fileTone: ThemeColor = "muted";
      if (counts.errors) fileTone = "error";
      else if (counts.warnings) fileTone = "warning";
      out.push(
        ...panelFieldRows(panel, {
          label: "FILE",
          value: `${displayPath(path)} · ${parts.join(" ")}`,
          inner,
          tone: fileTone,
        }),
      );
    }
  }
  const statusWidth = Math.max(1, inner - 1);
  for (const value of values) {
    const lines = wrapTextWithAnsi(value, statusWidth);
    for (const line of lines)
      out.push(panelFrame(panel, ` ${line}`, inner));
  }
  return out;
}

function performanceRows(
  panel: SidepanelPanel,
  inner: number,
  compact: boolean,
): string[] {
  const th = panel.theme;
  const out = [panelSep(panel, inner, "PERFORMANCE")];
  const active = perf.start > 0;
  const outputLive = active && perf.chars > 0;
  const now = Date.now();
  const promptLive =
    live.promptPps > 0 && live.at > 0 &&
    now - live.at < LIVE_STALE_MS;
  const upstreamTpsFresh =
    upstreamMetrics.tps > 0 && upstreamMetrics.tpsAt > 0 &&
    now - upstreamMetrics.tpsAt < SERVER_RATE_STALE_MS;
  const swapTpsFresh =
    swap.srvTps > 0 && swap.srvTpsAt > 0 &&
    now - swap.srvTpsAt < SERVER_RATE_STALE_MS;
  const serverTpsFresh = upstreamTpsFresh || swapTpsFresh;
  const serverTps = upstreamTpsFresh
    ? upstreamMetrics.tps
    : swap.srvTps;
  const requestTpsFresh =
    active && upstreamTpsFresh &&
    upstreamMetrics.tpsAt >= perf.start;
  let tps = perf.tps;
  if (requestTpsFresh) tps = upstreamMetrics.tps;
  else if (active) tps = outputLive ? liveTps() : 0;
  else if (serverTpsFresh) tps = serverTps;
  const tpsTone: ThemeColor =
    requestTpsFresh || !outputLive ? "success" : "accent";
  let tpsSuffix = "";
  if (requestTpsFresh) tpsSuffix = th.fg("dim", " server");
  else if (outputLive) tpsSuffix = th.fg("dim", " ~live");
  else if (serverTpsFresh) tpsSuffix = th.fg("dim", " server");
  out.push(
    panelFrame(panel, ` ${th.fg("dim", "TOK/S".padEnd(9))}${th.fg(tpsTone, tps ? tps.toFixed(1) : "—")}${tpsSuffix}`,
    inner,),
  );
  const upstreamPpsFresh =
    upstreamMetrics.promptPps > 0 && upstreamMetrics.promptPpsAt > 0 &&
    now - upstreamMetrics.promptPpsAt < SERVER_RATE_STALE_MS;
  const swapPpsFresh =
    swap.srvPps > 0 && swap.srvPpsAt > 0 &&
    now - swap.srvPpsAt < SERVER_RATE_STALE_MS;
  const serverPpsFresh = upstreamPpsFresh || swapPpsFresh;
  const serverPps = upstreamPpsFresh
    ? upstreamMetrics.promptPps
    : swap.srvPps;
  const requestPpsFresh =
    active && upstreamPpsFresh &&
    upstreamMetrics.promptPpsAt >= perf.start;
  const livePromptEstimate =
    active &&
    !promptLive &&
    !perf.first &&
    perf.livePromptTokens > 0 &&
    perf.start > 0;
  let pps = perf.pps;
  let ppsSuffix = " ~est";
  if (promptLive) {
    pps = live.promptPps;
    ppsSuffix = live.promptPpsServer ? " server" : " ~live";
  } else if (requestPpsFresh) {
    pps = upstreamMetrics.promptPps;
    ppsSuffix = " server";
  } else if (livePromptEstimate) {
    const elapsed = (now - perf.start) / 1000;
    pps = elapsed > 0
      ? perf.livePromptTokens / elapsed
      : 0;
    ppsSuffix = " ~live";
  } else if (active) {
    pps = 0;
    ppsSuffix = "";
  } else if (serverPpsFresh) {
    pps = serverPps;
    ppsSuffix = "";
  }
  let ppsDisplay = "—";
  if (pps) ppsDisplay = `${pps.toFixed(1)}${ppsSuffix}`;
  out.push(panelField(panel, { label: "PROMPT/S", value: ppsDisplay, inner: inner, tone: "muted" }));
  if (active && live.promptProcessed > 0) {
    if (live.promptProgressKnown && live.promptTotal > 0) {
      const progress = Math.min(
        1,
        Math.max(0, live.promptProcessed / live.promptTotal),
      );
      const percent = Math.round(progress * 100);
      const estimateMark = live.promptTotalEstimated ? "~" : "";
      out.push(
        panelField(panel, { label: "PROGRESS", value: `${bar(th, Math.round(progress * 10), 10, "accent")} ${estimateMark}${percent}% ${fmtTokens(live.promptProcessed)}/${fmtTokens(live.promptTotal)}`, inner: inner, tone: "muted" }),
      );
    } else {
      out.push(
        panelField(panel, { label: "PROGRESS", value: `${fmtTokens(live.promptProcessed)} processed`, inner: inner, tone: "muted" }),
      );
    }
  }
  if (compact) return out;
  const promptTotal = swap.cacheTokens + swap.inputTokens;
  if (swap.kvKnown && promptTotal) {
    const hit = Math.round((swap.cacheTokens / promptTotal) * 100);
    out.push(
      panelField(panel, { label: "KV CACHE", value: `${fmtTokens(swap.cacheTokens)}/${fmtTokens(promptTotal)} hit ${hit}%`, inner: inner, tone: "muted" }),
    );
  }
  out.push(
    panelField(panel, { label: "PEAK", value: perf.peakTps ? `${perf.peakTps.toFixed(1)} tok/s` : "—", inner: inner, tone: "muted" }),
    panelField(panel, { label: "TTFT", value: perf.ttft ? fmtMs(perf.ttft) : "—", inner: inner, tone: "muted" }),
  );
  let duration = "—";
  if (perf.start)
    duration = fmtMs(Math.max(1, Date.now() - perf.start));
  else if (perf.lastMs) duration = fmtMs(perf.lastMs);
  out.push(panelField(panel, { label: "DURATION", value: duration, inner: inner, tone: "muted" }));
  const up = Math.floor((Date.now() - sessionStart) / 60000);
  out.push(
    panelField(panel, { label: "UPTIME", value: `${Math.floor(up / 60)}h ${String(up % 60).padStart(2, "0")}m`, inner: inner, tone: "muted" }),
  );
  return out;
}

function swapRows(
  panel: SidepanelPanel,
  inner: number,
  compact: boolean,
): string[] {
  if (!swap.base) return [];
  const th = panel.theme;
  const section =
    swap.kind === "ninfer" ? "NINFER" : "LLAMA-SWAP";
  const out = [panelSep(panel, inner, section)];
  let st: string;
  if (swap.state === "ready") st = th.fg("success", "IN VRAM");
  else if (swap.state === "asleep") st = th.fg("muted", "ASLEEP");
  else if (swap.state === "error") st = th.fg("error", "OFFLINE");
  else if (swap.state === "loading")
    st = th.fg("warning", `LOADING ${secsSince(swap.since)}s`);
  else st = th.fg("warning", "CHECKING");
  const load =
    swap.state === "ready" && swap.loadMs
      ? th.fg("dim", ` load ${fmtMs(swap.loadMs)}`)
      : "";
  out.push(
    panelFrame(panel, ` ${th.fg("dim", "STATUS".padEnd(9))}${st}${load}`,
    inner,),
  );
  if (compact) return [...out, costRow(panel, inner)];
  if (swap.state === "error")
    out.push(panelFrame(panel, " " + th.fg("error", swap.error), inner));
  const gib = (n: number) => n / 2 ** 30;
  for (const [i, g] of swap.gpus.entries()) {
    const pct = g.memTotal
      ? (g.memUsed / g.memTotal) * 100
      : 0;
    out.push(
      panelFrame(panel, ` ${th.fg("dim", `VRAM${i}`.padEnd(9))}${bar(th, Math.round(pct / 10), 10, "accent")} ${th.fg("muted", `${gib(g.memUsed).toFixed(1)}/${Math.round(gib(g.memTotal))}G`)}`,
      inner,),
      panelFrame(panel, ` ${th.fg("dim", `GPU${i}`.padEnd(9))}${th.fg(g.util > 0 ? "accent" : "muted", `${Math.round(g.util)}%`.padEnd(6))}${th.fg(g.temp >= 80 ? "error" : "muted", `${Math.round(g.temp)}°C`.padEnd(7))}${th.fg("muted", `${Math.round(g.power)}W`)}`,
      inner,),
    );
  }
  if (swap.ramTotal)
    out.push(
      panelField(panel, { label: "RAM", value: `${gib(swap.ramUsed).toFixed(1)} / ${Math.round(gib(swap.ramTotal))}G`, inner: inner, tone: "muted" }),
    );
  if (swap.gpus.length)
    out.push(
      panelField(panel, { label: "ENERGY", value: `${(totalWh() / 1000).toFixed(3)} kWh`, inner: inner, tone: "muted" }),
    );
  out.push(costRow(panel, inner));
  return out;
}

interface SidepanelPanel extends Component {
  theme: Theme;
  frame: number;
  fillHeight?: () => number;
  invalidate(): void;
  dispose(): void;
}

function createSidepanelPanel(
  tui: TUI,
  theme: Theme,
): SidepanelPanel {
  let timer: ReturnType<typeof setInterval> | null = null;
  let cache:
    | {
        at: number;
        inner: number;
        compact: boolean;
        lines: string[];
      }
    | undefined;
  const panel: SidepanelPanel = {
    theme,
    frame: 0,
    invalidate(): void {
      cache = undefined;
    },
    dispose(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },

    render(width: number): string[] {
      const inner = Math.max(24, width - 2);
      const now = Date.now();
      if (
        !cache ||
        cache.inner !== inner ||
        cache.compact !== ui.compact ||
        now - cache.at > 500
      ) {
        const compact = ui.compact;
        cache = {
          at: now,
          inner,
          compact,
          lines: [
            ...sessionRows(panel, inner, compact),
            ...telemetryRows(panel, inner, compact),
            ...performanceRows(panel, inner, compact),
            ...swapRows(panel, inner, compact),
          ],
        };
      }
      const bottom = panel.theme.fg(
        "border",
        "└" + "─".repeat(inner) + "┘",
      );
      const lines = [
        ...statusSection(panel, inner),
        ...locationRows(panel, inner),
        ...cache.lines,
        ...extensionRows(panel, inner),
        ...piLensRows(panel, inner),
      ];
      const target = (panel.fillHeight?.() ?? 0) - 1;
      while (lines.length < target)
        lines.push(panelFrame(panel, "", inner));
      return [...lines, bottom].map((line) =>
        truncateToWidth(line, width),
      );
    },
  };
  timer = setInterval(() => {
    panel.frame++;
    const cwd = displayPath(liveCtx?.cwd);
    const cwdNeedsScroll =
      visibleWidth(cwd) > panelWidth - 13;
    if (
      animating() ||
      cwdNeedsScroll ||
      panel.frame % 8 === 0
    )
      tui.requestRender();
  }, 125);
  return panel;
}

/* ──────────────────────────────────────────────────────── config ── */

interface SidepanelConfig {
  ui?: {
    compact?: boolean;
    kwhPrice?: number;
    currency?: "EUR" | "USD";
    panelWidth?: number;
  };
  loads?: Record<string, number>;
  totalWh?: number;
  ninfer?: { urls?: string[]; apiKey?: string };
}

const SIDE_PANEL_CONFIG_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "sidepanel.json",
);

function loadSidepanelConfig(): SidepanelConfig {
  try {
    const parsed = decodeWireValue(
      JSON.parse(
        readFileSync(SIDE_PANEL_CONFIG_PATH, "utf8"),
      ) as WireValue,
    );
    const record = parsed && jsonObject(parsed);
    return record ? (record as SidepanelConfig) : {};
  } catch {
    return {};
  }
}

function saveSidepanelConfig(cfg: SidepanelConfig): void {
  mkdirSync(join(homedir(), ".pi", "agent"), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(
    SIDE_PANEL_CONFIG_PATH,
    JSON.stringify(cfg, null, 2) + "\n",
    { encoding: "utf8", mode: 0o600 },
  );
  // mode is ignored when the file already exists.
  chmodSync(SIDE_PANEL_CONFIG_PATH, 0o600);
}

/* ── panel UI preferences ── */

const ui = {
  compact: false,
  kwhPrice: undefined as number | undefined,
  currency: "EUR" as "EUR" | "USD",
};

let panelWidth = PANEL_WIDTH;

/* ──────────────────────────────────────────────────────── extension ── */

let liveCtx: ExtensionContext | undefined;
let footerDataRef: ReadonlyFooterDataProvider | undefined;

function extensionStatusEntries(): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of
    footerDataRef?.getExtensionStatuses?.() ?? []) {
    const text = value
      .replace(/[\r\n\t]/g, " ")
      .replace(/ +/g, " ")
      .trim();
    if (text) entries.push([key, text]);
  }
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

function piLensStatusValues(): string[] {
  return extensionStatusEntries().flatMap(([key, value]) =>
    key.toLowerCase().startsWith("pi-lens")
      ? [value]
      : [],
  );
}

let tuiRef: TUI | undefined;
let panelHandle: ReturnType<TUI["showOverlay"]> | undefined;
let panel: SidepanelPanel | undefined;
let wrappedRoot: Component | undefined;
let titleDone = false;

function windowTitle(cwd: string, done = false): string {
  return `${done ? "✓ " : ""}π - Sidepanel - ${displayPath(cwd)}`;
}

const showPanel = (theme: Theme) => {
  if (!tuiRef || panel || !panelEnabled) return;
  panel = createSidepanelPanel(tuiRef, theme);

  // SAFETY: tuiRef is a TUI instance; we access private layoutRoot/setLayoutRoot for fullscreen mode
  const t = tuiRef as unknown as {
    mode: string;
    layoutRoot?: Component;
    setLayoutRoot: (root: Component) => void;
  };
  if (
    t.mode === "fullscreen" &&
    t.layoutRoot
  ) {
    panel.fillHeight = () => tuiRef?.terminal.rows ?? 0;
    wrappedRoot = t.layoutRoot;
    t.setLayoutRoot(
      new HStack(
        [
          {
            component: wrappedRoot,
            basis: 0,
            grow: 1,
            shrink: 1,
            minSize: 40,
          },
          {
            component: panel,
            basis: panelWidth,
            grow: 0,
            shrink: 0,
            visible: (vp: { width: number }) =>
              vp.width >= panelWidth + 56,
          },
        ],
        { gap: 1 },
      ),
    );
    tuiRef.requestRender();
    return;
  }

  panelHandle = tuiRef.showOverlay(panel, {
    nonCapturing: true,
    anchor: "top-right",
    width: panelWidth,
    maxHeight: "92%",
    margin: { top: 1, right: 1, bottom: 1 },
    visible: (termWidth: number) =>
      termWidth >= panelWidth + 56,
  });
};

const hidePanel = () => {
  if (wrappedRoot && tuiRef) {
    // SAFETY: wrappedRoot is only set after the fullscreen TUI exposes setLayoutRoot.
    const t = tuiRef as unknown as {
      setLayoutRoot?: (root: Component) => void;
    };
    t.setLayoutRoot?.(wrappedRoot);
    wrappedRoot = undefined;
  }
  panelHandle?.hide();
  panel?.dispose();
  panelHandle = undefined;
  panel = undefined;
};

const repaint = () => {
  panel?.invalidate();
  tuiRef?.requestRender();
};

let panelEnabled = true;
interface NInferModelRecord {
  id?: string;
  owned_by?: string;
  max_model_len?: number;
  architecture?: { input_modalities?: string[] };
}

interface ActivityTokens {
  cache_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  tokens_per_second?: number;
  prompt_per_second?: number;
}

interface ActivityRow {
  model?: string;
  timestamp?: string;
  resp_status_code?: number;
  duration_ms?: number;
  tokens?: ActivityTokens;
}

interface ActivityReport {
  data?: ActivityRow[];
  total?: number;
}

async function discoverNinfer(
  pi: ExtensionAPI,
  cfg: SidepanelConfig["ninfer"],
): Promise<void> {
  const urls = (cfg?.urls ?? []).filter(
    (url) => url.trim().length > 0,
  );
  if (!urls.length) return;
  const apiKey = cfg?.apiKey ?? "";
  const headers: Record<string, string> = apiKey
    ? { Authorization: `Bearer ${apiKey}` }
    : {};
  const lists = await Promise.all(
    urls.map(async (url) => {
      const baseUrl = normalizeServiceBase(url) + "/v1";
      try {
        const response = await fetch(`${baseUrl}/models`, {
          headers,
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) return [];
        const { data } = (await response.json()) as {
          data?: NInferModelRecord[];
        };
        return (data ?? []).flatMap(
          (m): ProviderModelConfig[] => {
            if (m.owned_by !== "ninfer" || !m.id) return [];
            const contextWindow = Math.max(
              1,
              Number(m.max_model_len) || 32768,
            );
            return [
              {
                id: m.id,
                name: m.id,
                baseUrl,
                reasoning: false,
                input:
                  m.architecture?.input_modalities?.includes(
                    "image",
                  )
                    ? ["text", "image"]
                    : ["text"],
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                compat: {
                  supportsDeveloperRole: false,
                  supportsReasoningEffort: true,
                  supportsUsageInStreaming: true,
                  supportsStore: false,
                  supportsStrictMode: false,
                  maxTokensField: "max_tokens",
                },
                contextWindow,
                maxTokens: Math.min(32768, contextWindow),
              },
            ];
          },
        );
      } catch {
        return [];
      }
    }),
  );
  const models: ProviderModelConfig[] = lists.flat();
  const baseUrl = models[0]?.baseUrl;
  if (!baseUrl) return;
  pi.registerProvider("ninfer", {
    api: "openai-completions",
    baseUrl,
    apiKey: apiKey || "ninfer",
    models,
  });
}

type AssistantStreamEvent =
  MessageUpdateEvent["assistantMessageEvent"];

function updateAssistantPhase(
  event: AssistantStreamEvent,
): void {
  const type = event?.type;
  if (type === "thinking_start" || type === "thinking_delta")
    setPhase("thinking");
  else if (type === "text_start" || type === "text_delta")
    setPhase("responding");
  else if (
    type === "toolcall_start" ||
    type === "toolcall_delta"
  ) {
    setPhase("tool");
    const call = event.partial?.content?.[event.contentIndex];
    if (call?.type === "toolCall") {
      state.toolName = call.name ?? "";
      state.toolTarget = toolTarget(call.arguments);
    }
  }
}

function updateAssistantTokenSamples(
  event: AssistantStreamEvent,
): void {
  if (event && "delta" in event && event.delta) {
    if (!perf.first) perf.first = Date.now();
    perf.chars += event.delta.length;
  }
  if (event && "partial" in event) {
    const usage = event.partial.usage;
    const promptTokens =
      usage.input + usage.cacheRead + usage.cacheWrite;
    if (promptTokens > 0)
      perf.livePromptTokens = promptTokens;
    if (usage.output > 0)
      perf.liveOutputTokens = usage.output;
  }
}

function recordAssistantPerformance(
  message: AssistantMessage,
): void {
  if (!perf.start) return;
  const end = Date.now();
  perf.lastMs =
    message.durationMs ?? Math.max(1, end - perf.start);
  const firstTokenMs = perf.first
    ? Math.max(0, perf.first - perf.start)
    : 0;
  const responseMs = Math.max(1, perf.lastMs);
  const promptTokens =
    (message.usage?.input ?? 0) +
    (message.usage?.cacheRead ?? 0) +
    (message.usage?.cacheWrite ?? 0) ||
    perf.livePromptTokens;
  if (
    promptTokens > 0 &&
    firstTokenMs > 0 &&
    firstTokenMs <= responseMs
  ) {
    const estimate =
      promptTokens / (firstTokenMs / 1000);
    if (
      Number.isFinite(estimate) &&
      estimate <= MAX_ESTIMATED_PROMPT_PPS
    )
      perf.pps = estimate;
  }
  const outputTokens =
    message.usage?.output ||
    perf.liveOutputTokens ||
    perf.chars / 4;
  const generationMs =
    firstTokenMs > 0 && firstTokenMs < responseMs
      ? responseMs - firstTokenMs
      : responseMs;
  if (outputTokens > 0 && generationMs > 0) {
    perf.tps = outputTokens / (generationMs / 1000);
    perf.peakTps = Math.max(perf.peakTps, perf.tps);
  }
  if (firstTokenMs > 0) perf.ttft = firstTokenMs;
  perf.start = 0;
}

function refreshMetricsAfterMessage(): void {
  setTimeout(() => {
    const refreshes = [
      refreshSwapMetrics(),
      refreshUpstreamMetrics(),
    ];
    if (swap.kind === "llama-swap")
      refreshes.push(refreshSwapActivity());
    void Promise.all(refreshes).then(() => repaint());
  }, 300);
}

function buildSwapStatusLines(
  ctx: ExtensionContext,
  rows: ActivityRow[],
  total: number,
): string[] {
  const dim = (text: string) =>
    ctx.ui.theme.fg("dim", text);
  const mean = (values: number[]) =>
    values.length
      ? values.reduce((a, b) => a + b, 0) / values.length
      : 0;
  const ago = (iso: string) => {
    const minutes = Math.max(
      0,
      Math.round((Date.now() - Date.parse(iso)) / 60000),
    );
    return minutes < 60
      ? `${minutes}m ago`
      : `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
  };
  const lines = [
    ctx.ui.theme.fg(
      "accent",
      ctx.ui.theme.bold("LLAMA-SWAP STATUS"),
    ) + dim(` · last ${rows.length} of ${total} requests`),
  ];
  const byModel = new Map<string, ActivityRow[]>();
  for (const row of rows) {
    if (!row.model) continue;
    byModel.set(row.model, [
      ...(byModel.get(row.model) ?? []),
      row,
    ]);
  }
  for (const [model, modelRows] of byModel) {
    const tokenRows = modelRows.map((row) => row.tokens ?? {});
    const sum = (
      selector: (tokens: ActivityTokens) => number,
    ) =>
      tokenRows.reduce(
        (totalTokens, tokens) =>
          totalTokens + Math.max(0, selector(tokens)),
        0,
      );
    const errors = modelRows.filter(
      (row) => (row.resp_status_code ?? 0) >= 400,
    ).length;
    const gen = mean(
      tokenRows
        .map((tokens) => tokens.tokens_per_second ?? 0)
        .filter((value) => value > 0),
    );
    const prompt = mean(
      tokenRows
        .map((tokens) => tokens.prompt_per_second ?? 0)
        .filter((value) => value > 0),
    );
    const cached = sum((tokens) => tokens.cache_tokens ?? 0);
    const input = sum((tokens) => tokens.input_tokens ?? 0);
    const output = sum((tokens) => tokens.output_tokens ?? 0);
    const durations = modelRows
      .map((row) =>
        finiteNumber(row.duration_ms)
          ? row.duration_ms
          : Number.NaN,
      )
      .filter((duration) => Number.isFinite(duration))
      .sort((a, b) => a - b);
    const p95 = durations.length
      ? (durations[
          Math.min(
            durations.length - 1,
            Math.floor(durations.length * 0.95),
          )
        ] ?? 0)
      : 0;
    lines.push(
      "",
      ctx.ui.theme.fg("text", ctx.ui.theme.bold(model)),
      dim("  requests ") +
        ctx.ui.theme.fg("text", String(modelRows.length)) +
        dim(" · errors ") +
        ctx.ui.theme.fg(
          errors ? "error" : "success",
          String(errors),
        ) +
        dim(` · last ${ago(modelRows[0]?.timestamp ?? "")}`),
      dim("  speed    ") +
        ctx.ui.theme.fg("success", `gen ${gen.toFixed(1)} tok/s`) +
        dim(" · ") +
        ctx.ui.theme.fg("text", `prompt ${prompt.toFixed(1)} tok/s`),
      dim("  tokens   ") +
        ctx.ui.theme.fg(
          "text",
          `in ${fmtTokens(input)} · cached ${fmtTokens(cached)}`,
        ) +
        dim(
          ` (hit ${cached + input ? Math.round((cached / (cached + input)) * 100) : 0}%)`,
        ) +
        ctx.ui.theme.fg("text", ` · out ${fmtTokens(output)}`),
      dim("  duration ") +
        ctx.ui.theme.fg(
          "text",
          `avg ${fmtMs(mean(durations))} · p95 ${fmtMs(p95)} · max ${fmtMs(durations.at(-1) ?? 0)}`,
        ),
    );
  }
  return lines;
}

async function showSwapStatus(
  ctx: ExtensionContext,
): Promise<void> {
  if (swap.kind !== "llama-swap") {
    ctx.ui.notify(
      "/sidepanel status needs a llama-swap session model",
      "warning",
    );
    return;
  }
  let report: ActivityReport;
  try {
    const response = await swapGet(
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

async function configureCost(
  ctx: ExtensionContext,
): Promise<void> {
  const currency = await ctx.ui.select(
    `Currency for COST (current: ${ui.currency})`,
    ["EUR", "USD"],
  );
  if (!currency) return;
  const current =
    ui.kwhPrice === undefined
      ? ""
      : ` (current: ${ui.kwhPrice})`;
  const raw = (
    await ctx.ui.input(
      `Electricity price per kWh in ${currency}${current}:`,
      "0.30",
    )
  )?.trim();
  if (raw === undefined) return;
  const price =
    raw === "" && ui.kwhPrice !== undefined
      ? ui.kwhPrice
      : Number(raw.replace(",", "."));
  if (raw === "" && ui.kwhPrice === undefined) {
    ctx.ui.notify("No price entered: COST unchanged", "warning");
    return;
  }
  if (!Number.isFinite(price) || price < 0) {
    ctx.ui.notify(`Invalid price: "${raw}"`, "error");
    return;
  }
  ui.currency = currency === "USD" ? "USD" : "EUR";
  ui.kwhPrice = price;
  const cfg = loadSidepanelConfig();
  saveSidepanelConfig({
    ...cfg,
    ui: {
      ...cfg.ui,
      currency: ui.currency,
      kwhPrice: price,
    },
  });
  repaint();
  ctx.ui.notify(
    `COST: ${ui.currency === "USD" ? `$${price.toFixed(3)}` : `${price.toFixed(3)} €`} per kWh`,
    "info",
  );
}

export default async function (pi: ExtensionAPI) {
  const sidepanelCfg = loadSidepanelConfig();
  await discoverNinfer(pi, sidepanelCfg.ninfer);

  ui.compact = sidepanelCfg.ui?.compact === true;
  ui.kwhPrice = nonNegativeNumber(
    sidepanelCfg.ui?.kwhPrice,
  );
  panelWidth = clampPanelWidth(
    nonNegativeNumber(sidepanelCfg.ui?.panelWidth) ??
      PANEL_WIDTH,
  );
  ui.currency =
    sidepanelCfg.ui?.currency === "USD" ? "USD" : "EUR";
  swap.diskWh = nonNegativeNumber(sidepanelCfg.totalWh) ?? 0;

  const disableChrome = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    hidePanel();
    ctx.ui.setWidget("pi-lens", undefined);
    ctx.ui.setWidget("sidepanel-hook", undefined);
    ctx.ui.setHeader(undefined);
    ctx.ui.setFooter(undefined);
    footerDataRef = undefined;
  };

  const applyChrome = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    if (!panelEnabled) {
      disableChrome(ctx);
      return;
    }
    ctx.ui.setWidget("pi-lens", undefined);
    ctx.ui.setWidget(
      "sidepanel-hook",
      (tui: TUI, theme: Theme) => {
        tuiRef = tui;
        queueMicrotask(() => showPanel(theme));
        return { render: () => [], invalidate: () => {} };
      },
    );
    // Keep Pi's normal header; the side panel is the only custom chrome.
    ctx.ui.setHeader(undefined);
    ctx.ui.setFooter(
      (
        _tui: TUI,
        _theme: Theme,
        footerData: ReadonlyFooterDataProvider,
      ) => {
        footerDataRef = footerData;
        const unsubscribeBranch = footerData.onBranchChange(
          () => repaint(),
        );
        return {
          render: () => [],
          invalidate: () => {},
          // Keep the provider reference even if another extension replaces
          // this footer; it remains the shared source for extension statuses.
          dispose: unsubscribeBranch,
        };
      },
    );
    ctx.ui.setTitle(windowTitle(ctx.cwd, titleDone));
  };

  let metricsTimer:
    | ReturnType<typeof setInterval>
    | undefined;
  let unsubscribeInput: (() => void) | undefined;
  let lastPoll = 0;
  let titleTimer:
    | ReturnType<typeof setInterval>
    | undefined;
  let liveTimer: ReturnType<typeof setInterval> | undefined;
  const runningTools = new Map<
    string,
    { name: string; target: string }
  >();
  type PiLensEventHandler = Parameters<
    typeof pi.events.on
  >[1];
  const onPiLensEvent: PiLensEventHandler =
    (...args) => {
      const decoded = decodeWireValue(
        args[0] as WireValue,
      );
      if (decoded !== undefined)
        rememberPiLensEvent(decoded);
      repaint();
    };
  for (const channel of [
    "pilens:files:touched",
    "pilens:format:start",
    "pilens:format:done",
    "pilens:autofix:start",
    "pilens:diagnostics",
    "pi-lens/analysis-complete",
    "pi-lens/findings",
  ]) {
    pi.events.on(channel, onPiLensEvent);
  }

  const resetSessionView = (
    ctx: ExtensionContext,
  ): void => {
    resetSessionState();
    panelEnabled = true;
    titleDone = false;
    runningTools.clear();
    liveCtx = ctx;
    piLensState.currentFile = "";
    piLensState.languages.clear();
    piLensState.files.clear();
    recountSession(ctx);
    state.hasSmartCompact = pi.getCommands().some(
      (command: { name: string }) =>
        command.name?.replace(/^\/?/, "") ===
        "smart-compact",
    );
  };

  const startSessionTimers = (
    ctx: ExtensionContext,
  ): void => {
    applyChrome(ctx);
    void probeModel(ctx)
      .then(() => repaint())
      .catch(() => undefined);
    clearInterval(metricsTimer);
    lastPoll = 0;
    metricsTimer = setInterval(() => {
      const now = Date.now();
      if (
        !animating(now) &&
        now - lastPoll < IDLE_POLL_MS
      )
        return;
      lastPoll = now;
      void Promise.all([
        refreshSwapMetrics(),
        refreshUpstreamMetrics(),
      ])
        .then(() => refreshSwapRunning())
        .then(repaint);
    }, BUSY_POLL_MS);
    clearInterval(liveTimer);
    liveTimer = setInterval(() => {
      if (perf.start > 0 || state.phase !== "idle")
        void refreshLiveContext().then(repaint);
    }, LIVE_POLL_MS);
  };

  const bindSessionUi = (
    ctx: ExtensionContext,
  ): void => {
    unsubscribeInput?.();
    unsubscribeInput = ctx.ui.onTerminalInput(() => {
      if (titleDone) {
        titleDone = false;
        ctx.ui.setTitle(windowTitle(ctx.cwd));
      }
      if (swap.state === "asleep" && liveCtx)
        void preloadModel(liveCtx);
      return undefined;
    });
    clearInterval(titleTimer);
    titleTimer = setInterval(() => {
      const current = liveCtx;
      if (panelEnabled && current?.mode === "tui")
        current.ui.setTitle(
          windowTitle(current.cwd, titleDone),
        );
    }, TITLE_REFRESH_MS);
  };

  pi.on(
    "session_start",
    (
      _event: SessionStartEvent,
      ctx: ExtensionContext,
    ) => {
      resetSessionView(ctx);
      if (ctx.mode !== "tui") return;
      startSessionTimers(ctx);
      bindSessionUi(ctx);
    },
  );

  pi.on(
    "session_tree",
    (
      _event: SessionTreeEvent,
      ctx: ExtensionContext,
    ) => {
      liveCtx = ctx;
      recountSession(ctx);
      repaint();
    },
  );

  pi.on(
    "model_select",
    (
      event: ModelSelectEvent,
      ctx: ExtensionContext,
    ) => {
      liveCtx = ctx;
      // Prompt speed is model-specific; do not carry it across selections.
      perf.pps = 0;
      if (ctx.mode === "tui")
        void preloadModel(ctx, event.model).catch(
          () => undefined,
        );
    },
  );

  pi.on("session_shutdown", () => {
    persistEnergy(true);
    clearInterval(metricsTimer);
    metricsTimer = undefined;
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    clearInterval(titleTimer);
    titleTimer = undefined;
    clearInterval(liveTimer);
    liveTimer = undefined;
    runningTools.clear();
    state.toolName = "";
    state.toolTarget = "";
    hidePanel();
  });

  pi.on("agent_start", () => {
    state.runStart = Date.now();
  });

  pi.on(
    "turn_start",
    (
      _event: TurnStartEvent,
      ctx: ExtensionContext,
    ) => {
      liveCtx = ctx;
      state.turns++;
      setPhase("thinking");
      repaint();
    },
  );

  pi.on(
    "message_start",
    (event: MessageStartEvent) => {
      if (event.message.role !== "assistant") return;
      perf.start = Date.now();
      perf.first = 0;
      perf.chars = 0;
      perf.livePromptTokens = 0;
      perf.liveOutputTokens = 0;
      perf.pps = 0;
      live.promptTokens = 0;
      live.promptAt = 0;
      live.promptPps = 0;
      live.promptPpsServer = false;
      live.promptTotal = 0;
      live.promptProcessed = 0;
      live.promptProgressKnown = false;
      live.promptTotalEstimated = false;
    },
  );

  pi.on(
    "message_update",
    (
      event: MessageUpdateEvent,
      ctx: ExtensionContext,
    ) => {
      liveCtx = ctx;
      const streamEvent = event.assistantMessageEvent;
      updateAssistantPhase(streamEvent);
      updateAssistantTokenSamples(streamEvent);
    },
  );

  pi.on("message_end", (event: MessageEndEvent) => {
    if (event.message.role !== "assistant") return;
    const message = event.message as AssistantMessage;
    countAssistant(message);
    recordAssistantPerformance(message);
    repaint();
    refreshMetricsAfterMessage();
  });

  pi.on(
    "tool_execution_start",
    (
      event: ToolExecutionStartEvent,
      ctx: ExtensionContext,
    ) => {
      liveCtx = ctx;
      const tool = {
        name: event.toolName ?? "",
        target: toolTarget(event.args),
      };
      if (/edit|write|patch/i.test(tool.name))
        rememberPiLensEvent(event.args);
      runningTools.set(event.toolCallId, tool);
      setPhase("tool");
      state.toolName = tool.name;
      state.toolTarget = tool.target;
      repaint();
    },
  );

  pi.on(
    "tool_execution_end",
    (event: ToolExecutionEndEvent) => {
      const tool = runningTools.get(event.toolCallId);
      runningTools.delete(event.toolCallId);
      if (event.isError) {
        state.toolFail++;
        state.lastFailAt = Date.now();
        state.lastFailTool =
          event.toolName ?? tool?.name ?? "tool";
        state.lastFailTarget = tool?.target ?? "";
      } else {
        state.toolOk++;
      }
      const running = [...runningTools.values()][0];
      if (running) {
        state.toolName = running.name;
        state.toolTarget = running.target;
      } else {
        setPhase("thinking");
        state.toolName = "";
        state.toolTarget = "";
      }
      repaint();
    },
  );

  pi.on(
    "agent_settled",
    (
      _event: AgentSettledEvent,
      ctx: ExtensionContext,
    ) => {
      liveCtx = ctx;
      if (state.runStart)
        state.lastRunMs = Date.now() - state.runStart;
      state.runStart = 0;
      setPhase("idle");
      runningTools.clear();
      state.toolName = "";
      state.toolTarget = "";
      if (state.lastRunMs > 30000) {
        titleDone = true;
        ctx.ui.setTitle(windowTitle(ctx.cwd, true));
      }
      repaint();
    },
  );

  pi.on("session_before_compact", () => {
    state.compacting = true;
    state.compactSince = Date.now();
    state.compactBy = state.hasSmartCompact
      ? "smart-compact"
      : "pi native";
    repaint();
  });

  pi.on(
    "session_compact",
    (event: SessionCompactEvent) => {
      state.compacting = false;
      if (event.fromExtension) {
        state.compactBy = state.hasSmartCompact
          ? "smart-compact"
          : "extension";
      } else {
        state.compactBy = "pi native";
      }
      repaint();
    },
  );

  pi.on("session_compact_failed", () => {
    state.compacting = false;
    repaint();
  });

  pi.registerCommand("sidepanel", {
    description:
      "Manage the side panel: panel|compact|status|off|cost",
    getArgumentCompletions: (prefix: string) => {
      const table: [string, string][] = [
        ["panel", "hide/show the side panel"],
        ["compact", "toggle the compact side panel"],
        [
          "width",
          `set panel width (${MIN_PANEL_WIDTH}-${MAX_PANEL_WIDTH})`,
        ],
        ["status", "llama-swap report"],
        ["off", "disable the side panel"],
        [
          "cost",
          "electricity price and currency for the COST row",
        ],
      ];
      const p = prefix.trimStart().toLowerCase();
      const items = table.flatMap(([value, description]) =>
        value.startsWith(p)
          ? [{ value, label: value, description }]
          : [],
      );
      return items.length ? items : null;
    },
    handler: async (
      args: string,
      ctx: ExtensionContext,
    ) => {
      const arg = args.trim();
      const [command, value] = arg.split(/\s+/, 2);
      if (arg === "panel") {
        panelEnabled = !panelEnabled;
        if (panelEnabled) {
          applyChrome(ctx);
        } else {
          disableChrome(ctx);
        }
        ctx.ui.notify(
          `Side panel ${panelEnabled ? "enabled" : "disabled"}`,
          "info",
        );
        return;
      }
      if (arg === "compact") {
        ui.compact = !ui.compact;
        const cfg = loadSidepanelConfig();
        saveSidepanelConfig({
          ...cfg,
          ui: { ...cfg.ui, compact: ui.compact },
        });
        repaint();
        ctx.ui.notify(
          `Side panel ${ui.compact ? "compact" : "detailed"}`,
          "info",
        );
        return;
      }
      if (command === "width") {
        const requested =
          value === "reset" ? PANEL_WIDTH : Number(value);
        if (
          !value ||
          (!Number.isFinite(requested) && value !== "reset")
        ) {
          ctx.ui.notify(
            `Usage: /sidepanel width ${MIN_PANEL_WIDTH}-${MAX_PANEL_WIDTH} or reset`,
            "warning",
          );
          return;
        }
        panelWidth = clampPanelWidth(requested);
        const cfg = loadSidepanelConfig();
        saveSidepanelConfig({
          ...cfg,
          ui: { ...cfg.ui, panelWidth },
        });
        if (panelEnabled) {
          hidePanel();
          applyChrome(ctx);
        }
        ctx.ui.notify(
          `Side panel width: ${panelWidth}`,
          "info",
        );
        return;
      }
      if (arg === "status") {
        await showSwapStatus(ctx);
        return;
      }
      if (arg === "off") {
        panelEnabled = false;
        disableChrome(ctx);
        ctx.ui.notify("Sidepanel chrome disabled", "info");
        return;
      }
      if (arg === "cost") {
        await configureCost(ctx);
        return;
      }
      return ctx.ui.notify(
        arg
          ? `Unknown /sidepanel command "${arg}"`
          : "Type /sidepanel and a space to see commands",
        arg ? "warning" : "info",
      );
    },
  });
}
