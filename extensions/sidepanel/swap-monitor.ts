import type {
  Api,
  Model,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadSidepanelConfig, nonNegativeNumber, saveSidepanelConfig } from "./config.js";
import type { ActivityRow } from "./activity.js";
import {
  metricValue,
  normalizeServiceBase,
  parsePrometheusSamples,
} from "./prometheus.js";

const LOAD_DEFAULT_MS = 60000;
const LIVE_STALE_MS = 5000;
const MIN_PROMPT_SAMPLE_MS = 250;
const MAX_ESTIMATED_PROMPT_PPS = 1_000_000;

interface MonitorState {
  phase: "idle" | "thinking" | "responding" | "tool";
}

interface MonitorPerf {
  start: number;
  first: number;
}

let state: MonitorState;
let perf: MonitorPerf;
let getLiveContext = () => undefined as ExtensionContext | undefined;
let repaint: () => void = () => {};

export function configureSwapMonitor(deps: {
  state: MonitorState;
  perf: MonitorPerf;
  getLiveContext: () => ExtensionContext | undefined;
  repaint: () => void;
}): void {
  state = deps.state;
  perf = deps.perf;
  getLiveContext = deps.getLiveContext;
  repaint = deps.repaint;
}

function finiteNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
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

export const swap = {
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

export const upstreamMetrics = {
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

export function swapGet(
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

interface SwapMetric {
  key: string;
  labels: string;
  value: number;
  matchesModel: boolean;
}

interface SwapMetricAccumulator {
  gpus: Map<string, GpuStat>;
  ramUsed: number;
  ramTotal: number;
  srvTps: number;
  srvPps: number;
  cacheTokens: number;
  promptTokens: number;
  hasCacheTokens: boolean;
  hasPromptTokens: boolean;
}

function parseSwapMetric(line: string): SwapMetric | undefined {
  const match =
    /^(?:llamaswap|ninfer)_([a-z_]+)(?:\{([^}]*)\})?\s+(\S+)$/.exec(line);
  if (!match?.[1]) return undefined;
  const value = Number(match[3]);
  if (!Number.isFinite(value)) return undefined;
  const labels = match[2] ?? "";
  const metricModel = /(?:model|model_id|model_name)="([^"]*)"/.exec(labels)?.[1];
  return {
    key: match[1],
    labels,
    value,
    matchesModel:
      !metricModel ||
      metricModel === swap.realId ||
      metricModel === swap.modelId,
  };
}

function createSwapMetricAccumulator(): SwapMetricAccumulator {
  return {
    gpus: new Map(),
    ramUsed: 0,
    ramTotal: 0,
    srvTps: 0,
    srvPps: 0,
    cacheTokens: 0,
    promptTokens: 0,
    hasCacheTokens: false,
    hasPromptTokens: false,
  };
}

function updateGpuMetric(
  accumulator: SwapMetricAccumulator,
  metric: SwapMetric,
): void {
  if (!metric.key.startsWith("gpu_")) return;
  const id = /id="([^"]*)"/.exec(metric.labels)?.[1] ?? "0";
  const gpu = accumulator.gpus.get(id) ?? {
    name: /name="([^"]*)"/.exec(metric.labels)?.[1] ?? "GPU",
    util: 0,
    memUsed: 0,
    memTotal: 0,
    temp: 0,
    power: 0,
  };
  if (metric.key === "gpu_util_percent") gpu.util = metric.value;
  else if (metric.key === "gpu_memory_used_bytes")
    gpu.memUsed = metric.value;
  else if (metric.key === "gpu_memory_total_bytes")
    gpu.memTotal = metric.value;
  else if (metric.key === "gpu_temperature_celsius")
    gpu.temp = metric.value;
  else if (metric.key === "gpu_power_draw_watts")
    gpu.power = metric.value;
  accumulator.gpus.set(id, gpu);
}

function updateSwapMetric(
  accumulator: SwapMetricAccumulator,
  metric: SwapMetric,
): void {
  switch (metric.key) {
    case "memory_used_bytes":
      accumulator.ramUsed = metric.value;
      break;
    case "memory_total_bytes":
      accumulator.ramTotal = metric.value;
      break;
    case "last_tokens_per_second":
      if (metric.matchesModel)
        accumulator.srvTps = Math.max(0, metric.value);
      break;
    case "last_prompt_per_second":
      if (metric.matchesModel)
        accumulator.srvPps = Math.max(0, metric.value);
      break;
    case "last_cache_tokens":
      if (metric.matchesModel) {
        accumulator.cacheTokens = Math.max(0, metric.value);
        accumulator.hasCacheTokens = true;
      }
      break;
    case "last_prompt_tokens":
      if (metric.matchesModel) {
        accumulator.promptTokens = Math.max(0, metric.value);
        accumulator.hasPromptTokens = true;
      }
      break;
    default:
      break;
  }
  updateGpuMetric(accumulator, metric);
}

function applySwapMetricAccumulator(
  accumulator: SwapMetricAccumulator,
): void {
  swap.ramUsed = accumulator.ramUsed;
  swap.ramTotal = accumulator.ramTotal;
  const now = Date.now();
  if (accumulator.srvTps > 0) {
    swap.srvTps = accumulator.srvTps;
    swap.srvTpsAt = now;
  }
  if (accumulator.srvPps > 0) {
    swap.srvPps = accumulator.srvPps;
    swap.srvPpsAt = now;
  }
  if (accumulator.hasCacheTokens || accumulator.hasPromptTokens) {
    const nextCache = accumulator.hasCacheTokens
      ? accumulator.cacheTokens
      : swap.cacheTokens;
    swap.cacheTokens = nextCache;
    if (accumulator.hasPromptTokens)
      swap.inputTokens = Math.max(
        0,
        accumulator.promptTokens - nextCache,
      );
    swap.kvKnown = true;
  }
  swap.gpus = [...accumulator.gpus.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, gpu]) => gpu);
}

function parseSwapMetrics(text: string): void {
  const accumulator = createSwapMetricAccumulator();
  for (const line of text.split("\n")) {
    const metric = parseSwapMetric(line);
    if (metric) updateSwapMetric(accumulator, metric);
  }
  applySwapMetricAccumulator(accumulator);
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

export function totalWh(): number {
  return swap.diskWh + swap.energyWh - swap.savedWh;
}

const ENERGY_SAVE_MS = 60000;
let lastPersistAt = 0;

export function persistEnergy(force = false): void {
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

let metricsCycleInFlight: Promise<void> | undefined;
let metricsActivityPending = false;

export function refreshMetricsCycle(
  includeActivity = false,
): Promise<void> {
  metricsActivityPending ||= includeActivity;
  if (metricsCycleInFlight) return metricsCycleInFlight;
  const runActivity = metricsActivityPending;
  metricsActivityPending = false;

  const operation = (async () => {
    await Promise.all([
      refreshSwapMetrics(),
      refreshUpstreamMetrics(),
    ]);
    await refreshSwapRunning();
    if (runActivity && swap.kind === "llama-swap")
      await refreshSwapActivity();
  })();
  let tracked: Promise<void>;
  tracked = operation.finally(() => {
    if (metricsCycleInFlight === tracked) {
      metricsCycleInFlight = undefined;
      if (metricsActivityPending)
        void refreshMetricsCycle().then(repaint);
    }
  });
  metricsCycleInFlight = tracked;
  return tracked;
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

export const live = {
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

export function resetMonitorState(): void {
  swapConnectionVersion++;
  metricsCycleInFlight = undefined;
  metricsActivityPending = false;
  liveContextInFlight = undefined;
  resetSwapObservation();
}

function liveSlotProgress(slot: SwapSlot): number {
  if (finiteNumber(slot.n_prompt_tokens_processed))
    return slot.n_prompt_tokens_processed;
  return slot.n_prompt_tokens ?? 0;
}

function activeLiveSlot(slots: SwapSlot[]): SwapSlot | undefined {
  const busy = slots.filter((slot) => {
    if (slot.is_processing !== true) return false;
    return liveSlotProgress(slot) > 0;
  });
  return busy.reduce<SwapSlot | undefined>((best, slot) => {
    if (!best || liveSlotProgress(slot) > liveSlotProgress(best))
      return slot;
    return best;
  }, undefined);
}

function reportedSlotProgress(
  slot: SwapSlot,
): number | undefined {
  if (
    finiteNumber(slot.progress) &&
    slot.progress > 0 &&
    slot.progress <= 1
  )
    return slot.progress;
  return undefined;
}

function slotPromptTotal(slot: SwapSlot): number {
  if (
    finiteNumber(slot.n_prompt_tokens) &&
    slot.n_prompt_tokens > 0
  )
    return slot.n_prompt_tokens;
  return 0;
}

function slotPromptBudget(slot: SwapSlot): number {
  const nRemain = slot.next_token?.[0]?.n_remain;
  if (
    !finiteNumber(slot.n_ctx) ||
    !finiteNumber(nRemain) ||
    nRemain < 0
  )
    return 0;
  return Math.max(0, slot.n_ctx - nRemain);
}

function estimatedPromptTotal(
  promptTokens: number,
  slotTotal: number,
  promptBudget: number,
  reportedProgress: number | undefined,
): number {
  if (reportedProgress !== undefined)
    return Math.ceil(promptTokens / reportedProgress);
  const contextTokens = getLiveContext()?.getContextUsage?.()?.tokens;
  const current = Math.max(slotTotal, promptBudget);
  if (contextTokens != null && contextTokens > promptTokens)
    return contextTokens;
  return current;
}

function promptFinished(
  slot: SwapSlot,
  promptTokens: number,
  promptBudget: number,
): boolean {
  const generationStarted =
    slot.next_token?.some(
      (token) =>
        finiteNumber(token.n_decoded) && token.n_decoded > 0,
    ) ?? false;
  if (generationStarted) return true;
  if (promptBudget > 0) return promptTokens >= promptBudget;
  return (
    finiteNumber(slot.n_prompt_tokens) &&
    finiteNumber(slot.n_prompt_tokens_processed) &&
    slot.n_prompt_tokens_processed >= slot.n_prompt_tokens
  );
}

function updateLivePromptProgress(
  slot: SwapSlot,
  promptTokens: number,
): void {
  const reportedProgress = reportedSlotProgress(slot);
  const slotTotal = slotPromptTotal(slot);
  const promptBudget = slotPromptBudget(slot);
  const estimatedTotal = estimatedPromptTotal(
    promptTokens,
    slotTotal,
    promptBudget,
    reportedProgress,
  );
  const finished = promptFinished(
    slot,
    promptTokens,
    promptBudget,
  );
  live.promptTotal = finished ? promptTokens : estimatedTotal;
  live.promptProcessed = promptTokens;
  live.promptProgressKnown = live.promptTotal > 0;
  live.promptTotalEstimated =
    !finished &&
    reportedProgress === undefined &&
    promptBudget === 0 &&
    slotTotal === 0 &&
    estimatedTotal > 0;
}

function updateLiveCache(slot: SwapSlot): void {
  if (
    !finiteNumber(slot.n_prompt_tokens) ||
    !finiteNumber(slot.n_prompt_tokens_cache)
  )
    return;
  swap.cacheTokens = Math.max(0, slot.n_prompt_tokens_cache);
  swap.inputTokens = Math.max(
    0,
    slot.n_prompt_tokens - slot.n_prompt_tokens_cache,
  );
  swap.kvKnown = true;
}

function updateLivePromptRate(
  slot: SwapSlot,
  promptTokens: number,
  now: number,
): void {
  if (perf.first) return;
  const serverPps = slot.timings?.prompt_per_second;
  const timingPromptN = slot.timings?.prompt_n;
  const timingPromptMs = slot.timings?.prompt_ms;
  if (finiteNumber(serverPps) && serverPps > 0) {
    live.promptPps = serverPps;
    live.promptPpsServer = true;
  } else if (
    finiteNumber(timingPromptN) &&
    finiteNumber(timingPromptMs) &&
    timingPromptN > 0 &&
    timingPromptMs > 0
  ) {
    live.promptPps = timingPromptN / (timingPromptMs / 1000);
    live.promptPpsServer = true;
  } else if (live.promptAt && promptTokens < live.promptTokens) {
    live.promptPps = 0;
    live.promptPpsServer = false;
  } else {
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

function updateLiveSlot(slot: SwapSlot, now: number): void {
  const promptTokens = liveSlotProgress(slot);
  updateLivePromptProgress(slot, promptTokens);
  updateLiveCache(slot);
  updateLivePromptRate(slot, promptTokens, now);
  live.tokens = finiteNumber(slot.n_prompt_tokens)
    ? slot.n_prompt_tokens
    : promptTokens;
  live.at = now;
}

async function refreshLiveContextNow(): Promise<void> {
  if (swap.kind !== "llama-swap" || swap.state !== "ready")
    return;
  const version = swapConnectionVersion;
  const modelId = swap.modelId;
  const base = swap.base;
  if (!base) return;
  try {
    const response = await swapFetch(
      base,
      { ...swap.headers },
      `/upstream/${encodeURIComponent(swap.realId)}/slots?model=${encodeURIComponent(swap.realId)}`,
      1500,
    );
    if (!response.ok) return;
    const slots = (await response.json()) as SwapSlot[];
    if (!isCurrentSwap(version, modelId, base)) return;
    const slot = activeLiveSlot(slots);
    if (!slot) return;
    updateLiveSlot(slot, Date.now());
  } catch {
    // The previous estimate remains visible when the server is unavailable.
  }
}

let liveContextInFlight: Promise<void> | undefined;

export function refreshLiveContext(): Promise<void> {
  if (liveContextInFlight) return liveContextInFlight;

  const operation = refreshLiveContextNow();
  let tracked: Promise<void>;
  tracked = operation.finally(() => {
    if (liveContextInFlight === tracked)
      liveContextInFlight = undefined;
  });
  liveContextInFlight = tracked;
  return tracked;
}

export function contextUsage():
  | {
      tokens: number | null;
      contextWindow: number;
      percent: number;
      live: boolean;
    }
  | undefined {
  const usage = getLiveContext()?.getContextUsage?.();
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

export async function connectSwap(
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
  void refreshMetricsCycle(true);
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
  void refreshMetricsCycle(true);
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

export async function probeModel(
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

export async function preloadModel(
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
      void refreshMetricsCycle();
    }
  }
}


