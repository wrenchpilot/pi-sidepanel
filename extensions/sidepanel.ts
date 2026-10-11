/**
 * Side Panel — a lightweight stats panel for the pi TUI.
 */

import { readFileSync, writeFileSync } from "node:fs";
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
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

/* ──────────────────────────────────────────────────────── constants ── */

const PANEL_WIDTH = 34;
const MIN_PANEL_WIDTH = 28;
const MAX_PANEL_WIDTH = 72;
const FAIL_FLASH_MS = 2500;
const ONLINE_MS = 3000;
const LIVE_POLL_MS = 500;
const LIVE_STALE_MS = 2000;
const BUSY_POLL_MS = 3000;
const IDLE_POLL_MS = 30000;
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

const sessionStart = Date.now();

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

const piLensState = {
  currentFile: "",
  languages: new Set<string>(),
};

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

function piLensEventPaths(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;
  const paths: string[] = [];
  if (typeof record.filePath === "string")
    paths.push(record.filePath);
  if (typeof record.file_path === "string")
    paths.push(record.file_path);
  if (typeof record.path === "string")
    paths.push(record.path);
  for (const key of ["paths", "files", "changedFiles"]) {
    const values = record[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (typeof value === "string") paths.push(value);
      else if (
        value &&
        typeof value === "object" &&
        typeof (value as Record<string, unknown>).path ===
          "string"
      ) {
        paths.push(
          (value as Record<string, unknown>).path as string,
        );
      }
    }
  }
  return paths;
}

function rememberPiLensEvent(data: unknown): void {
  for (const path of piLensEventPaths(data)) {
    piLensState.currentFile = path;
    const language = piLensLanguage(path);
    if (language) piLensState.languages.add(language);
  }
}

function truncateTo(
  target: string | undefined,
  maxLen: number,
): string {
  if (!target) return "—";
  return truncateToWidth(target, maxLen);
}

function marqueeToWidth(
  target: string,
  maxWidth: number,
  offset: number,
): string {
  if (visibleWidth(target) <= maxWidth) return target;
  const loop = `${target}   `;
  const period = visibleWidth(loop);
  return sliceByColumn(
    loop + loop,
    offset % period,
    maxWidth,
    true,
  );
}

function clampPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return PANEL_WIDTH;
  return Math.min(
    MAX_PANEL_WIDTH,
    Math.max(MIN_PANEL_WIDTH, Math.round(width)),
  );
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

function toolTarget(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
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
    if (typeof a[key] === "string" && a[key])
      return String(a[key]).replace(/\s+/g, " ").trim();
  }
  const first = Object.values(a).find(
    (v) =>
      typeof v === "string" &&
      v.length > 0 &&
      v.length < 200,
  );
  return typeof first === "string"
    ? first.replace(/\s+/g, " ").trim()
    : "";
}

/* ── performance ── */

const perf = {
  start: 0,
  first: 0,
  chars: 0,
  tps: 0,
  ttft: 0,
  lastMs: 0,
  peakTps: 0,
};

function liveTps(): number {
  if (state.phase !== "idle" && perf.first && perf.chars) {
    const s = (Date.now() - perf.first) / 1000;
    if (s > 0.3) return perf.chars / 4 / s;
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
  srvPps: 0,
  cacheTokens: 0,
  inputTokens: 0,
  energyWh: 0,
  diskWh: 0,
  savedWh: 0,
  lastSampleAt: 0,
  lastWatts: 0,
};

let swapConnectionVersion = 0;

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

function parseSwapMetrics(text: string): void {
  const gpus = new Map<string, GpuStat>();
  for (const line of text.split("\n")) {
    const m =
      /^(?:llamaswap|ninfer)_([a-z_]+)(?:\{([^}]*)\})?\s+(\S+)$/.exec(
        line,
      );
    if (!m) continue;
    const key = m[1];
    if (!key) continue;
    const labels = m[2] ?? "";
    const value = Number(m[3]);
    if (key === "memory_used_bytes") swap.ramUsed = value;
    else if (key === "memory_total_bytes")
      swap.ramTotal = value;
    else if (key === "last_tokens_per_second" && value > 0)
      swap.srvTps = value;
    else if (key === "last_prompt_per_second" && value > 0)
      swap.srvPps = value;
    else if (key === "last_cache_tokens")
      swap.cacheTokens = value;
    else if (key === "last_prompt_tokens")
      swap.inputTokens = Math.max(
        0,
        value - swap.cacheTokens,
      );
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
  swap.gpus = [...gpus.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, g]) => g);
}

function sampleEnergy(now = Date.now()): void {
  const watts = swap.gpus.reduce(
    (sum, g) => sum + g.power,
    0,
  );
  if (swap.lastSampleAt) {
    const dtH =
      Math.min(60000, now - swap.lastSampleAt) / 3600000;
    swap.energyWh += ((swap.lastWatts + watts) / 2) * dtH;
  }
  swap.lastSampleAt = now;
  persistEnergy();
}

function totalWh(): number {
  return swap.diskWh + swap.energyWh - swap.savedWh;
}

const ENERGY_SAVE_MS = 60000;
let lastPersistAt = 0;

function persistEnergy(): void {
  const delta = swap.energyWh - swap.savedWh;
  if (
    delta <= 0 ||
    Date.now() - lastPersistAt < ENERGY_SAVE_MS
  )
    return;
  lastPersistAt = Date.now();
  const cfg = loadSidepanelConfig();
  cfg.totalWh = (cfg.totalWh ?? 0) + delta;
  try {
    saveSidepanelConfig(cfg);
  } catch {
    return;
  }
  swap.savedWh = swap.energyWh;
  swap.diskWh = cfg.totalWh;
}

async function refreshSwapMetrics(): Promise<void> {
  if (!swap.base) return;
  try {
    parseSwapMetrics(
      await (await swapGet("/metrics")).text(),
    );
    sampleEnergy();
  } catch {
    // server unreachable: keep the last values
  }
}

async function refreshSwapRunning(): Promise<void> {
  if (swap.kind === "ninfer") return refreshNinferHealth();
  if (!swap.base || swap.state !== "ready") return;
  try {
    const { running } = (await (
      await swapGet("/running")
    ).json()) as { running?: { model: string }[] };
    if (
      !(running ?? []).some((r) => r.model === swap.realId)
    )
      setSwapState("asleep");
  } catch {
    // optional
  }
}

async function refreshNinferHealth(): Promise<void> {
  try {
    const res = await swapGet("/health", 3000);
    if (res.ok) {
      if (swap.state !== "ready") setSwapState("ready");
    } else
      setSwapState("error", `health HTTP ${res.status}`);
  } catch (err) {
    setSwapState(
      "error",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function refreshSwapActivity(): Promise<void> {
  if (swap.kind === "ninfer") return refreshSwapMetrics();
  if (!swap.base) return;
  try {
    const { data } = (await (
      await swapGet("/api/metrics/activity?limit=1")
    ).json()) as { data?: any[] };
    const t = data?.[0]?.tokens;
    if (!t) return;
    if (t.tokens_per_second > 0)
      swap.srvTps = t.tokens_per_second;
    if (t.prompt_per_second > 0)
      swap.srvPps = t.prompt_per_second;
    swap.cacheTokens = Math.max(0, t.cache_tokens ?? 0);
    swap.inputTokens = Math.max(0, t.input_tokens ?? 0);
  } catch {
    // metrics are optional
  }
}

/* ── live context ── */

const live = { tokens: 0, at: 0 };

async function refreshLiveContext(): Promise<void> {
  if (swap.kind !== "llama-swap" || swap.state !== "ready")
    return;
  try {
    const slots = (await (
      await swapGet(
        `/upstream/${encodeURIComponent(swap.realId)}/slots`,
        1500,
      )
    ).json()) as any[];
    const busy = slots.filter(
      (s) => s.is_processing && s.n_prompt_tokens > 0,
    );
    if (!busy.length) return;
    live.tokens = Math.max(
      ...busy.map((s) => s.n_prompt_tokens),
    );
    live.at = Date.now();
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
  const version = ++swapConnectionVersion;
  if (
    !model ||
    (model.provider !== "llama-swap" &&
      model.provider !== "ninfer") ||
    !model.baseUrl
  ) {
    swap.base = "";
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
  setSwapState("checking");
  const auth =
    await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (version !== swapConnectionVersion) return false;
  const base = normalizeServiceBase(model.baseUrl);
  const headers = {
    ...((auth.ok ? auth.headers : undefined) as
      | Record<string, string>
      | undefined),
    ...(auth.ok && auth.apiKey
      ? { Authorization: `Bearer ${auth.apiKey}` }
      : {}),
  };
  swap.base = base;
  swap.headers = headers;
  void refreshSwapMetrics();
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
  return true;
}

async function swapAliases(
  get: (path: string) => Promise<Response> = swapGet,
): Promise<Map<string, string>> {
  const aliases = new Map<string, string>();
  try {
    const { data } = (await (
      await get("/v1/models")
    ).json()) as { data?: any[] };
    for (const m of data ?? []) {
      const ls = m.meta?.llamaswap;
      aliases.set(
        m.id,
        ls?.type === "alias" && ls.modelID
          ? ls.modelID
          : m.id,
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
    const { running } = (await (
      await get("/running")
    ).json()) as {
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
  const id = model.id;
  const realId = swap.realId;
  const base = swap.base;
  const headers = { ...swap.headers };
  const state = (
    await swapRunning((path) =>
      swapFetch(base, headers, path),
    )
  ).get(realId);
  if (swap.modelId === id)
    setSwapState(state === "ready" ? "ready" : "asleep");
}

async function preloadModel(
  ctx: ExtensionContext,
  model: Model<Api> | undefined = ctx.model,
): Promise<void> {
  if (!(await connectSwap(ctx, model)) || !model) return;
  if (swap.kind === "ninfer") return refreshNinferHealth();
  const id = model.id;
  if (swap.modelId !== id) return;
  const base = swap.base;
  const headers = { ...swap.headers };
  const realId = swap.realId;
  swap.expectedLoadMs =
    loadSidepanelConfig().loads?.[realId] ??
    LOAD_DEFAULT_MS;

  const slow = setTimeout(() => {
    if (swap.modelId === id && swap.state === "checking")
      setSwapState("loading");
  }, 400);
  const started = Date.now();
  try {
    const res = await swapFetch(
      base,
      headers,
      `/upstream/${encodeURIComponent(id)}/health`,
      15 * 60000,
    );
    if (swap.modelId !== id) return;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const loaded = swap.state === "loading";
    if (loaded) {
      swap.loadMs = Date.now() - started;
      const cfg = loadSidepanelConfig();
      saveSidepanelConfig({
        ...cfg,
        loads: { ...cfg.loads, [realId]: swap.loadMs },
      });
    }
    setSwapState("ready");
  } catch (err) {
    if (swap.modelId === id)
      setSwapState(
        "error",
        err instanceof Error ? err.message : String(err),
      );
  } finally {
    clearTimeout(slow);
    void refreshSwapMetrics();
  }
}

/* ──────────────────────────────────────────────────────── side panel ── */

class SidepanelPanel implements Component {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null =
    null;
  private cache:
    | {
        at: number;
        inner: number;
        compact: boolean;
        lines: string[];
      }
    | undefined;
  fillHeight?: () => number;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
  ) {
    this.timer = setInterval(() => {
      this.frame++;
      const cwd = displayPath(liveCtx?.cwd);
      const cwdNeedsScroll =
        visibleWidth(cwd) > panelWidth - 13;
      const piLensNeedsScroll = piLensStatusValues().some(
        (value) => visibleWidth(value) > panelWidth - 3,
      );
      if (
        animating() ||
        cwdNeedsScroll ||
        piLensNeedsScroll ||
        this.frame % 8 === 0
      )
        this.tui.requestRender();
    }, 125);
  }

  invalidate(): void {
    this.cache = undefined;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /* ── drawing helpers ── */

  private pad(content: string, inner: number): string {
    const w = visibleWidth(content);
    if (w > inner) return truncateToWidth(content, inner);
    return content + " ".repeat(inner - w);
  }

  private frameLine(
    content: string,
    inner: number,
  ): string {
    const b = (s: string) => this.theme.fg("border", s);
    return b("│") + this.pad(content, inner) + b("│");
  }

  private labelLine(
    inner: number,
    label: string,
    left: string,
    right: string,
    tone: ThemeColor,
  ): string {
    const b = (s: string) => this.theme.fg("border", s);
    const text = ` ${truncateToWidth(label, inner - 4)} `;
    const rest = Math.max(
      0,
      inner - visibleWidth(text) - 1,
    );
    return (
      b(left + "─") +
      this.theme.fg(tone, text) +
      b("─".repeat(rest) + right)
    );
  }

  private sep(inner: number, label: string): string {
    return this.labelLine(inner, label, "├", "┤", "muted");
  }

  private field(
    label: string,
    value: string,
    inner: number,
    tone: ThemeColor = "text",
  ): string {
    const l = this.theme.fg("dim", label.padEnd(9));
    return this.frameLine(
      " " + l + this.theme.fg(tone, value),
      inner,
    );
  }

  /* ── top of the panel: status display ── */

  private statusSection(inner: number): string[] {
    const th = this.theme;
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
    } else if (
      idle &&
      (swap.state === "checking" ||
        swap.state === "loading")
    ) {
      title =
        swap.state === "loading"
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
      idle &&
      swap.state === "ready" &&
      now - swap.since < ONLINE_MS
    ) {
      title = swap.loadMs
        ? `ONLINE · ${fmtMs(swap.loadMs)}`
        : "ONLINE";
      titleTone = "success";
      status = `${pulse} model ready`;
    } else if (state.compacting) {
      title = `COMPACTING · ${state.compactBy || "context"} · ${secsSince(state.compactSince, now)}s`;
      titleTone = "warning";
      status = `${pulse} compacting context`;
    } else {
      title = "STANDBY";
      titleTone = "muted";
      status = `${pulse} at rest`;
    }

    const out: string[] = [];
    out.push(
      this.labelLine(inner, title, "┌", "┐", titleTone),
    );
    out.push(this.frameLine(status, inner));
    return out;
  }

  /* ── data rows ── */

  private locationRows(inner: number): string[] {
    const out = [this.sep(inner, "LOCATION")];
    const cwdWidth = Math.max(1, inner - 11);
    out.push(
      this.field(
        "CWD",
        marqueeToWidth(
          displayPath(liveCtx?.cwd),
          cwdWidth,
          this.frame,
        ),
        inner,
        "text",
      ),
    );
    out.push(
      this.field(
        "BRANCH",
        truncateTo(
          footerDataRef?.getGitBranch?.() ?? undefined,
          inner - 11,
        ),
        inner,
        "muted",
      ),
    );
    return out;
  }

  private piLensRows(inner: number): string[] {
    const values = piLensStatusValues();
    const languages = [...piLensState.languages]
      .sort((a, b) => a.localeCompare(b))
      .join(" ");
    if (
      !values.length &&
      !languages &&
      !piLensState.currentFile
    )
      return [];

    const out = [this.sep(inner, "PI-LENS")];
    if (languages)
      out.push(
        this.field("LANG", languages, inner, "muted"),
      );
    if (piLensState.currentFile) {
      const fileWidth = Math.max(1, inner - 11);
      out.push(
        this.field(
          "FILE",
          marqueeToWidth(
            displayPath(piLensState.currentFile),
            fileWidth,
            this.frame,
          ),
          inner,
          "text",
        ),
      );
    }
    const statusWidth = Math.max(1, inner - 1);
    out.push(
      ...values.map((value) =>
        this.frameLine(
          ` ${marqueeToWidth(value, statusWidth, this.frame)}`,
          inner,
        ),
      ),
    );
    return out;
  }

  private sessionRows(
    inner: number,
    compact: boolean,
  ): string[] {
    const out = [this.sep(inner, "SESSION")];
    const model = liveCtx?.model;
    out.push(
      this.field(
        "MODEL",
        truncateTo(model?.id, inner - 11),
        inner,
        "text",
      ),
    );
    if (!compact)
      out.push(
        this.field(
          "PROVIDER",
          truncateTo(String(model?.provider), inner - 11),
          inner,
          "muted",
        ),
      );
    out.push(
      this.field(
        "THINKING",
        liveCtx?.thinkingLevel ?? "off",
        inner,
        "muted",
      ),
    );
    return out;
  }

  private telemetryRows(
    inner: number,
    compact: boolean,
  ): string[] {
    const th = this.theme;
    const out = [this.sep(inner, "TELEMETRY")];
    if (!compact) {
      out.push(
        this.frameLine(
          ` ${th.fg("dim", "TURNS".padEnd(9))}${th.fg("text", String(state.turns))}`,
          inner,
        ),
      );
      out.push(
        this.frameLine(
          ` ${th.fg("dim", "TOKENS".padEnd(9))}${th.fg("success", "↑" + fmtTokens(tokens.input))} ${th.fg("warning", "↓" + fmtTokens(tokens.output))}`,
          inner,
        ),
      );
      if (tokens.cacheRead)
        out.push(
          this.field(
            "CACHE",
            fmtTokens(tokens.cacheRead),
            inner,
            "muted",
          ),
        );
      if (tokens.cost)
        out.push(
          this.field(
            "API COST",
            `$${tokens.cost.toFixed(3)}`,
            inner,
            "muted",
          ),
        );
    }

    // SYNC: the tool success rate
    const sync = syncPercent();
    out.push(
      this.frameLine(
        sync === null
          ? ` ${th.fg("dim", "SYNC".padEnd(9))}${th.fg("dim", "— no tools")}`
          : ` ${th.fg("dim", "SYNC".padEnd(9))}${bar(th, Math.round(sync / 10), 10, syncTone(sync))} ${th.fg(syncTone(sync), `${sync.toFixed(0)}%`)}`,
        inner,
      ),
    );

    // TOOLS
    out.push(
      this.frameLine(
        ` ${th.fg("dim", "TOOLS".padEnd(9))}${th.fg("success", `✓${state.toolOk}`)}${th.fg("dim", " Success ")}${th.fg(state.toolFail ? "error" : "dim", `✗${state.toolFail}`)}${th.fg("dim", " Failed")}`,
        inner,
      ),
    );

    // WINDOW: the context window
    const usage = contextUsage();
    const percent = usage?.percent ?? 0;
    const liveMark = usage?.live
      ? th.fg("accent", " ▲ live")
      : "";
    if (!compact && usage?.contextWindow) {
      out.push(
        this.field(
          "CONTEXT",
          `${usage.tokens == null ? "?" : fmtTokens(usage.tokens)} / ${fmtTokens(usage.contextWindow)}`,
          inner,
          "muted",
        ),
      );
    }
    out.push(
      this.frameLine(
        ` ${th.fg("dim", "WINDOW".padEnd(9))}${bar(th, Math.round(percent / 10), 10, usageTone(percent))} ${th.fg(usageTone(percent), `${percent.toFixed(0)}%`)}${liveMark}`,
        inner,
      ),
    );
    // HYGIENE: tokens pruned from what the model sees, ✂ = thinking cut
    if (!compact && (state.pruned || state.thinkCuts)) {
      const cuts = state.thinkCuts
        ? ` ✂${state.thinkCuts}`
        : "";
      out.push(
        this.field(
          "HYGIENE",
          `-${fmtTokens(state.pruned)}${cuts}`,
          inner,
          state.thinkCuts ? "warning" : "muted",
        ),
      );
    }
    return out;
  }

  private performanceRows(
    inner: number,
    compact: boolean,
  ): string[] {
    const th = this.theme;
    const out = [this.sep(inner, "PERFORMANCE")];
    const live = state.phase !== "idle" && perf.chars > 0;
    const tps = live ? liveTps() : swap.srvTps || perf.tps;
    const tpsTone: ThemeColor = live ? "accent" : "success";
    let tpsSuffix = "";
    if (live) tpsSuffix = th.fg("dim", " ~live");
    else if (swap.srvTps)
      tpsSuffix = th.fg("dim", " server");
    out.push(
      this.frameLine(
        ` ${th.fg("dim", "TOK/S".padEnd(9))}${th.fg(tpsTone, tps ? tps.toFixed(1) : "—")}${tpsSuffix}`,
        inner,
      ),
    );
    if (compact) return out;
    if (swap.srvPps)
      out.push(
        this.field(
          "PROMPT/S",
          swap.srvPps.toFixed(1),
          inner,
          "muted",
        ),
      );
    const promptTotal = swap.cacheTokens + swap.inputTokens;
    if (promptTotal) {
      const hit = Math.round(
        (swap.cacheTokens / promptTotal) * 100,
      );
      out.push(
        this.field(
          "KV CACHE",
          `${fmtTokens(swap.cacheTokens)}/${fmtTokens(promptTotal)} hit ${hit}%`,
          inner,
          "muted",
        ),
      );
    }
    out.push(
      this.field(
        "PEAK",
        perf.peakTps
          ? `${perf.peakTps.toFixed(1)} tok/s`
          : "—",
        inner,
        "muted",
      ),
    );
    out.push(
      this.field(
        "TTFT",
        perf.ttft ? fmtMs(perf.ttft) : "—",
        inner,
        "muted",
      ),
    );
    out.push(
      this.field(
        "DURATION",
        perf.lastMs ? fmtMs(perf.lastMs) : "—",
        inner,
        "muted",
      ),
    );
    const up = Math.floor(
      (Date.now() - sessionStart) / 60000,
    );
    out.push(
      this.field(
        "UPTIME",
        `${Math.floor(up / 60)}h ${String(up % 60).padStart(2, "0")}m`,
        inner,
        "muted",
      ),
    );
    return out;
  }

  private costRow(inner: number): string {
    if (!swap.gpus.length)
      return this.field("COST", "—", inner, "muted");
    const kwhPrice = ui.kwhPrice;
    if (kwhPrice === undefined)
      return this.field(
        "COST",
        "→ /sidepanel cost",
        inner,
        "dim",
      );
    const fmtMoney = (wh: number) => {
      const price = (wh / 1000) * kwhPrice;
      return ui.currency === "USD"
        ? `$${price.toFixed(3)}`
        : `${price.toFixed(3)} €`;
    };
    return this.field(
      "COST",
      fmtMoney(totalWh()) +
        this.theme.fg(
          "dim",
          ` (ses ${fmtMoney(swap.energyWh)})`,
        ),
      inner,
      "warning",
    );
  }

  private swapRows(
    inner: number,
    compact: boolean,
  ): string[] {
    if (!swap.base) return [];
    const th = this.theme;
    const section =
      swap.kind === "ninfer" ? "NINFER" : "LLAMA-SWAP";
    const out = [this.sep(inner, section)];
    let st: string;
    if (swap.state === "ready")
      st = th.fg("success", "IN VRAM");
    else if (swap.state === "asleep")
      st = th.fg("muted", "ASLEEP");
    else if (swap.state === "error")
      st = th.fg("error", "OFFLINE");
    else if (swap.state === "loading")
      st = th.fg(
        "warning",
        `LOADING ${secsSince(swap.since)}s`,
      );
    else st = th.fg("warning", "CHECKING");
    const load =
      swap.state === "ready" && swap.loadMs
        ? th.fg("dim", ` load ${fmtMs(swap.loadMs)}`)
        : "";
    out.push(
      this.frameLine(
        ` ${th.fg("dim", "STATUS".padEnd(9))}${st}${load}`,
        inner,
      ),
    );
    if (compact) return [...out, this.costRow(inner)];
    if (swap.state === "error")
      out.push(
        this.frameLine(
          " " + th.fg("error", swap.error),
          inner,
        ),
      );
    const gib = (n: number) => n / 2 ** 30;
    for (const [i, g] of swap.gpus.entries()) {
      const pct = g.memTotal
        ? (g.memUsed / g.memTotal) * 100
        : 0;
      out.push(
        this.frameLine(
          ` ${th.fg("dim", `VRAM${i}`.padEnd(9))}${bar(th, Math.round(pct / 10), 10, "accent")} ${th.fg("muted", `${gib(g.memUsed).toFixed(1)}/${Math.round(gib(g.memTotal))}G`)}`,
          inner,
        ),
      );
      out.push(
        this.frameLine(
          ` ${th.fg("dim", `GPU${i}`.padEnd(9))}${th.fg(g.util > 0 ? "accent" : "muted", `${Math.round(g.util)}%`.padEnd(6))}${th.fg(g.temp >= 80 ? "error" : "muted", `${Math.round(g.temp)}°C`.padEnd(7))}${th.fg("muted", `${Math.round(g.power)}W`)}`,
          inner,
        ),
      );
    }
    if (swap.ramTotal)
      out.push(
        this.field(
          "RAM",
          `${gib(swap.ramUsed).toFixed(1)} / ${Math.round(gib(swap.ramTotal))}G`,
          inner,
          "muted",
        ),
      );
    if (swap.gpus.length)
      out.push(
        this.field(
          "ENERGY",
          `${(totalWh() / 1000).toFixed(3)} kWh`,
          inner,
          "muted",
        ),
      );
    out.push(this.costRow(inner));
    return out;
  }

  render(width: number): string[] {
    const inner = Math.max(24, width - 2);
    const now = Date.now();
    if (
      !this.cache ||
      this.cache.inner !== inner ||
      this.cache.compact !== ui.compact ||
      now - this.cache.at > 500
    ) {
      const c = ui.compact;
      this.cache = {
        at: now,
        inner,
        compact: c,
        lines: [
          ...this.sessionRows(inner, c),
          ...this.telemetryRows(inner, c),
          ...this.performanceRows(inner, c),
          ...this.swapRows(inner, c),
        ],
      };
    }
    const bottom = this.theme.fg(
      "border",
      "└" + "─".repeat(inner) + "┘",
    );
    const lines = [
      ...this.statusSection(inner),
      ...this.locationRows(inner),
      ...this.cache.lines,
      ...this.piLensRows(inner),
    ];
    const target = (this.fillHeight?.() ?? 0) - 1;
    while (lines.length < target)
      lines.push(this.frameLine("", inner));
    return [...lines, bottom].map((l) =>
      truncateToWidth(l, width),
    );
  }
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
    return JSON.parse(
      readFileSync(SIDE_PANEL_CONFIG_PATH, "utf8"),
    );
  } catch {
    return {};
  }
}

function saveSidepanelConfig(cfg: SidepanelConfig): void {
  writeFileSync(
    SIDE_PANEL_CONFIG_PATH,
    JSON.stringify(cfg, null, 2) + "\n",
  );
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

function piLensStatusValues(): string[] {
  const values: string[] = [];
  for (const [
    key,
    value,
  ] of footerDataRef?.getExtensionStatuses?.() ?? []) {
    if (key.startsWith("pi-lens") && value)
      values.push(value);
  }
  return values;
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
  panel = new SidepanelPanel(tuiRef, theme);

  // SAFETY: tuiRef is a TUI instance; we access private layoutRoot/setLayoutRoot for fullscreen mode
  const t = tuiRef as unknown as {
    mode: string;
    layoutRoot?: Component;
    setLayoutRoot: (root: Component) => void;
  };
  if (
    t.mode === "fullscreen" &&
    t.layoutRoot &&
    typeof t.setLayoutRoot === "function"
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
  if (!cfg?.urls?.length) return;
  const headers: Record<string, string> = cfg.apiKey
    ? { Authorization: `Bearer ${cfg.apiKey}` }
    : {};
  const lists = await Promise.all(
    cfg.urls.map(async (url) => {
      const baseUrl = normalizeServiceBase(url) + "/v1";
      try {
        const { data } = (await (
          await fetch(`${baseUrl}/models`, {
            headers,
            signal: AbortSignal.timeout(3000),
          })
        ).json()) as { data?: NInferModelRecord[] };
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
    apiKey: cfg.apiKey || "ninfer",
    models,
  });
}

export default async function (pi: ExtensionAPI) {
  const sidepanelCfg = loadSidepanelConfig();
  await discoverNinfer(pi, sidepanelCfg.ninfer);

  ui.compact = sidepanelCfg.ui?.compact ?? false;
  ui.kwhPrice = sidepanelCfg.ui?.kwhPrice;
  panelWidth = clampPanelWidth(
    sidepanelCfg.ui?.panelWidth ?? PANEL_WIDTH,
  );
  ui.currency =
    sidepanelCfg.ui?.currency === "USD" ? "USD" : "EUR";
  swap.diskWh = sidepanelCfg.totalWh ?? 0;

  const disableChrome = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    hidePanel();
    ctx.ui.setWidget("pi-lens", undefined);
    ctx.ui.setWidget("sidepanel-hook", undefined);
    ctx.ui.setHeader(undefined);
    ctx.ui.setFooter(undefined);
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
          dispose: () => {
            unsubscribeBranch();
            if (footerDataRef === footerData)
              footerDataRef = undefined;
          },
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
  const onPiLensEvent = (data: unknown) => {
    rememberPiLensEvent(data);
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

  pi.on(
    "session_start",
    async (
      _event: SessionStartEvent,
      ctx: ExtensionContext,
    ) => {
      liveCtx = ctx;
      piLensState.currentFile = "";
      piLensState.languages.clear();
      recountSession(ctx);
      pi.getCommands().some((c: { name: string }) => {
        if (
          c.name?.replace(/^\/?/, "") === "smart-compact"
        ) {
          state.hasSmartCompact = true;
          return true;
        }
        return false;
      });
      if (ctx.mode !== "tui") return;
      applyChrome(ctx);
      void probeModel(ctx).then(
        () => void refreshSwapRunning(),
      );
      metricsTimer ??= setInterval(() => {
        const now = Date.now();
        if (
          !animating(now) &&
          now - lastPoll < IDLE_POLL_MS
        )
          return;
        lastPoll = now;
        void refreshSwapMetrics()
          .then(refreshSwapRunning)
          .then(repaint);
      }, BUSY_POLL_MS);
      liveTimer ??= setInterval(() => {
        if (state.phase !== "idle")
          void refreshLiveContext().then(repaint);
      }, LIVE_POLL_MS);
      unsubscribeInput ??= ctx.ui.onTerminalInput(() => {
        if (titleDone) {
          titleDone = false;
          ctx.ui.setTitle(windowTitle(ctx.cwd));
        }
        if (swap.state === "asleep" && liveCtx)
          void preloadModel(liveCtx);
        return undefined;
      });
      titleTimer ??= setInterval(() => {
        if (panelEnabled)
          ctx.ui.setTitle(windowTitle(ctx.cwd, titleDone));
      }, TITLE_REFRESH_MS);
    },
  );

  pi.on(
    "session_tree",
    async (
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
    async (
      event: ModelSelectEvent,
      ctx: ExtensionContext,
    ) => {
      liveCtx = ctx;
      if (ctx.mode === "tui")
        void preloadModel(ctx, event.model);
    },
  );

  pi.on("session_shutdown", async () => {
    persistEnergy();
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

  pi.on("agent_start", async () => {
    state.runStart = Date.now();
  });

  pi.on(
    "turn_start",
    async (
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
    async (event: MessageStartEvent) => {
      if (event.message.role !== "assistant") return;
      perf.start = Date.now();
      perf.first = 0;
      perf.chars = 0;
    },
  );

  pi.on(
    "message_update",
    async (
      event: MessageUpdateEvent,
      ctx: ExtensionContext,
    ) => {
      liveCtx = ctx;
      const e = event.assistantMessageEvent;
      const t = e?.type;
      if (t === "thinking_start" || t === "thinking_delta")
        setPhase("thinking");
      else if (t === "text_start" || t === "text_delta")
        setPhase("responding");
      else if (
        t === "toolcall_start" ||
        t === "toolcall_delta"
      ) {
        setPhase("tool");
        const call = e.partial?.content?.[e.contentIndex];
        if (call?.type === "toolCall") {
          state.toolName = call.name ?? "";
          state.toolTarget = toolTarget(call.arguments);
        }
      }
      if ("delta" in e && e.delta) {
        if (!perf.first) perf.first = Date.now();
        perf.chars += e.delta.length;
      }
    },
  );

  pi.on("message_end", async (event: MessageEndEvent) => {
    if (event.message.role !== "assistant") return;
    const m = event.message as AssistantMessage;
    countAssistant(m);
    if (perf.start) {
      const end = Date.now();
      perf.lastMs = end - perf.start;
      if (perf.first) {
        perf.ttft = perf.first - perf.start;
        const genS = (end - perf.first) / 1000;
        const out = m.usage?.output || perf.chars / 4;
        if (genS > 0.05 && out) {
          perf.tps = out / genS;
          perf.peakTps = Math.max(perf.peakTps, perf.tps);
        }
      }
      perf.start = 0;
    }
    repaint();
    setTimeout(
      () => void refreshSwapActivity().then(repaint),
      300,
    );
  });

  pi.on(
    "tool_execution_start",
    async (
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
    async (event: ToolExecutionEndEvent) => {
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
    async (
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

  pi.on("session_before_compact", async () => {
    state.compacting = true;
    state.compactSince = Date.now();
    state.compactBy = state.hasSmartCompact
      ? "smart-compact"
      : "pi native";
    repaint();
  });

  pi.on(
    "session_compact",
    async (event: SessionCompactEvent) => {
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

  pi.on("session_compact_failed", async () => {
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
        if (swap.kind !== "llama-swap") {
          ctx.ui.notify(
            "/sidepanel status needs a llama-swap session model",
            "warning",
          );
          return;
        }
        let report: ActivityReport;
        try {
          report = (await (
            await swapGet(
              `/api/metrics/activity?limit=${ACTIVITY_REPORT_ROWS}`,
              15000,
            )
          ).json()) as typeof report;
        } catch (err) {
          ctx.ui.notify(
            `llama-swap status failed: ${err instanceof Error ? err.message : String(err)}`,
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
        const dim = (s: string) =>
          ctx.ui.theme.fg("dim", s);
        const mean = (xs: number[]) =>
          xs.length
            ? xs.reduce((a, b) => a + b, 0) / xs.length
            : 0;
        const ago = (iso: string) => {
          const m = Math.max(
            0,
            Math.round(
              (Date.now() - Date.parse(iso)) / 60000,
            ),
          );
          return m < 60
            ? `${m}m ago`
            : `${Math.floor(m / 60)}h ${m % 60}m ago`;
        };
        const lines = [
          ctx.ui.theme.fg(
            "accent",
            ctx.ui.theme.bold("LLAMA-SWAP STATUS"),
          ) +
            dim(
              ` · last ${rows.length} of ${report.total ?? rows.length} requests`,
            ),
        ];
        const byModel = new Map<string, ActivityRow[]>();
        for (const row of rows) {
          if (!row.model) continue;
          byModel.set(row.model, [
            ...(byModel.get(row.model) ?? []),
            row,
          ]);
        }
        for (const [model, rs] of byModel) {
          const t = rs.map((row) => row.tokens ?? {});
          const sum = (
            selector: (tokens: ActivityTokens) => number,
          ) =>
            t.reduce(
              (total, tokens) =>
                total + Math.max(0, selector(tokens)),
              0,
            );
          const errors = rs.filter(
            (row) => (row.resp_status_code ?? 0) >= 400,
          ).length;
          const gen = mean(
            t
              .map(
                (tokens) => tokens.tokens_per_second ?? 0,
              )
              .filter((value) => value > 0),
          );
          const prompt = mean(
            t
              .map(
                (tokens) => tokens.prompt_per_second ?? 0,
              )
              .filter((value) => value > 0),
          );
          const cached = sum(
            (tokens) => tokens.cache_tokens ?? 0,
          );
          const input = sum(
            (tokens) => tokens.input_tokens ?? 0,
          );
          const durations = rs
            .map((r) =>
              typeof r.duration_ms === "number" &&
              Number.isFinite(r.duration_ms)
                ? r.duration_ms
                : Number.NaN,
            )
            .filter((duration) => Number.isFinite(duration))
            .sort((a, b) => a - b);
          lines.push(
            "",
            ctx.ui.theme.fg(
              "text",
              ctx.ui.theme.bold(model),
            ),
          );
          lines.push(
            dim("  requests ") +
              ctx.ui.theme.fg("text", String(rs.length)) +
              dim(" · errors ") +
              ctx.ui.theme.fg(
                errors ? "error" : "success",
                String(errors),
              ) +
              dim(` · last ${ago(rs[0]?.timestamp ?? "")}`),
          );
          lines.push(
            dim("  speed    ") +
              ctx.ui.theme.fg(
                "success",
                `gen ${gen.toFixed(1)} tok/s`,
              ) +
              dim(" · ") +
              ctx.ui.theme.fg(
                "text",
                `prompt ${prompt.toFixed(1)} tok/s`,
              ),
          );
          const output = sum(
            (tokens) => tokens.output_tokens ?? 0,
          );
          lines.push(
            dim("  tokens   ") +
              ctx.ui.theme.fg(
                "text",
                `in ${fmtTokens(input)} · cached ${fmtTokens(cached)}`,
              ) +
              dim(
                ` (hit ${cached + input ? Math.round((cached / (cached + input)) * 100) : 0}%)`,
              ) +
              ctx.ui.theme.fg(
                "text",
                ` · out ${fmtTokens(output)}`,
              ),
          );
          const p95 = durations.length
            ? (durations[
                Math.min(
                  durations.length - 1,
                  Math.floor(durations.length * 0.95),
                )
              ] ?? 0)
            : 0;
          lines.push(
            dim("  duration ") +
              ctx.ui.theme.fg(
                "text",
                `avg ${fmtMs(mean(durations))} · p95 ${fmtMs(p95)} · max ${fmtMs(durations.at(-1) ?? 0)}`,
              ),
          );
        }
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
            const row = (s: string) => {
              const t = truncateToWidth(` ${s}`, inner);
              return (
                theme.fg("accent", "│") +
                t +
                " ".repeat(
                  Math.max(0, inner - visibleWidth(t)),
                ) +
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
                ].map((l) => truncateToWidth(l, width));
              },
              handleInput(_data: string) {
                done(undefined);
              },
              invalidate() {},
            };
          },
        );
        return;
      }
      if (arg === "off") {
        panelEnabled = false;
        disableChrome(ctx);
        ctx.ui.notify("Sidepanel chrome disabled", "info");
        return;
      }
      if (arg === "cost") {
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
          ctx.ui.notify(
            "No price entered: COST unchanged",
            "warning",
          );
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
