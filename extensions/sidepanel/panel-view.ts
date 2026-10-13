import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  Container,
  HStack,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  bar,
  fmtMs,
  fmtTokens,
  secsSince,
  syncTone,
  usageTone,
} from "./format.js";
import {
  displayPath,
  emptyPiLensCounts,
  isPiLensStatus,
  isTechnicalDebtStatus,
  piLensState,
} from "./pilens.js";

const FAIL_FLASH_MS = 2500;
const ONLINE_MS = 3000;
const LIVE_STALE_MS = 5000;
const SERVER_RATE_STALE_MS = 120000;

interface PanelState {
  phase: "idle" | "thinking" | "responding" | "tool";
  phaseSince: number;
  toolName: string;
  toolTarget: string;
  turns: number;
  toolOk: number;
  toolFail: number;
  compacting: boolean;
  compactSince: number;
  compactBy: string;
  pruned: number;
  thinkCuts: number;
  lastFailAt: number;
  lastFailTool: string;
  lastFailTarget: string;
}

interface PanelGpu {
  name: string;
  util: number;
  memUsed: number;
  memTotal: number;
  temp: number;
  power: number;
}

interface PanelSwap {
  kind: "" | "llama-swap" | "ninfer";
  base: string;
  state: "off" | "checking" | "loading" | "ready" | "asleep" | "error";
  since: number;
  loadMs: number;
  error: string;
  gpus: PanelGpu[];
  ramUsed: number;
  ramTotal: number;
  srvTps: number;
  srvTpsAt: number;
  srvPps: number;
  srvPpsAt: number;
  cacheTokens: number;
  inputTokens: number;
  kvKnown: boolean;
  energyWh: number;
  diskWh: number;
}

interface PanelUpstreamMetrics {
  tps: number;
  tpsAt: number;
  promptPps: number;
  promptPpsAt: number;
}

interface PanelLive {
  tokens: number;
  at: number;
  promptPps: number;
  promptPpsServer: boolean;
  promptTotal: number;
  promptProcessed: number;
  promptProgressKnown: boolean;
  promptTotalEstimated: boolean;
}

interface PanelPerf {
  start: number;
  first: number;
  chars: number;
  livePromptTokens: number;
  liveOutputTokens: number;
  tps: number;
  pps: number;
  ttft: number;
  lastMs: number;
  peakTps: number;
}

interface PanelTokens {
  input: number;
  output: number;
  cacheRead: number;
  cost: number;
}

interface PanelUi {
  compact: boolean;
  kwhPrice: number | undefined;
  currency: "EUR" | "USD";
}

interface PanelContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number;
  live: boolean;
}

export interface PanelViewDeps {
  state: PanelState;
  swap: PanelSwap;
  upstreamMetrics: PanelUpstreamMetrics;
  live: PanelLive;
  perf: PanelPerf;
  tokens: PanelTokens;
  ui: PanelUi;
  getSessionStart: () => number;
  getLiveContext: () => ExtensionContext | undefined;
  getFooterData: () => ReadonlyFooterDataProvider | undefined;
  animating: (now?: number) => boolean;
  liveTps: () => number;
  contextUsage: () => PanelContextUsage | undefined;
  totalWh: () => number;
}

let state: PanelState;
let swap: PanelSwap;
let upstreamMetrics: PanelUpstreamMetrics;
let live: PanelLive;
let perf: PanelPerf;
let tokens: PanelTokens;
let ui: PanelUi;
let getSessionStart = () => 0;
let getLiveContext = () => undefined as ExtensionContext | undefined;
let getFooterData = () => undefined as ReadonlyFooterDataProvider | undefined;
let animate = (_now?: number) => false;
let currentLiveTps = () => 0;
let currentContextUsage = () => undefined as PanelContextUsage | undefined;
let currentTotalWh = () => 0;

export function configurePanelView(deps: PanelViewDeps): void {
  state = deps.state;
  swap = deps.swap;
  upstreamMetrics = deps.upstreamMetrics;
  live = deps.live;
  perf = deps.perf;
  tokens = deps.tokens;
  ui = deps.ui;
  getSessionStart = deps.getSessionStart;
  getLiveContext = deps.getLiveContext;
  getFooterData = deps.getFooterData;
  animate = deps.animating;
  currentLiveTps = deps.liveTps;
  currentContextUsage = deps.contextUsage;
  currentTotalWh = deps.totalWh;
}

function animating(now = Date.now()): boolean {
  return animate(now);
}

function liveTps(): number {
  return currentLiveTps();
}

function contextUsage(): PanelContextUsage | undefined {
  return currentContextUsage();
}

function totalWh(): number {
  return currentTotalWh();
}

function syncPercent(): number | null {
  const done = state.toolOk + state.toolFail;
  return done ? (state.toolOk / done) * 100 : null;
}

function truncateTo(target: string | undefined, maxLen: number): string {
  if (!target) return "—";
  return truncateToWidth(target, maxLen);
}

function extensionStatusEntries(): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of
    getFooterData()?.getExtensionStatuses?.() ?? []) {
    const text = value
      .replace(/[\r\n\t]/g, " ")
      .replace(/ +/g, " ")
      .trim();
    if (text) entries.push([key, text]);
  }
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

function piLensTechnicalDebt(
  statuses: Array<[string, string]>,
): string | undefined {
  return statuses.find(([key, value]) =>
    isTechnicalDebtStatus(key, value),
  )?.[1] ?? piLensState.technicalDebt;
}

function piLensStatusValues(
  statuses: Array<[string, string]>,
): string[] {
  return statuses.flatMap(([key, value]) =>
    isPiLensStatus(key) &&
    !isTechnicalDebtStatus(key, value)
      ? [value]
      : [],
  );
}

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
      value: displayPath(getLiveContext()?.cwd),
      inner,
      tone: "text",
    }),
    ...panelFieldRows(panel, {
      label: "BRANCH",
      value: truncateTo(
        getFooterData()?.getGitBranch?.() ?? undefined,
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
  statuses: Array<[string, string]>,
): string[] {
  const visibleStatuses = statuses.filter(
    ([key]) => !key.toLowerCase().startsWith("pi-lens"),
  );
  if (!visibleStatuses.length) return [];
  const out = [panelSep(panel, inner, "EXTENSIONS")];
  const valueWidth = Math.max(1, inner - 1);
  for (const [, value] of visibleStatuses) {
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
  const model = getLiveContext()?.model;
  out.push(
    panelField(panel, { label: "MODEL", value: truncateTo(model?.id, inner - 11), inner: inner, tone: "text" }),
  );
  if (!compact)
    out.push(
      panelField(panel, { label: "PROVIDER", value: truncateTo(String(model?.provider), inner - 11), inner: inner, tone: "muted" }),
    );
  out.push(
    panelField(panel, { label: "THINKING", value: getLiveContext()?.thinkingLevel ?? "off", inner: inner, tone: "muted" }),
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

interface StatusPresentation {
  title: string;
  tone: ThemeColor;
  status: string;
}

function toolPresentation(
  theme: Theme,
  inner: number,
  now: number,
  pulse: string,
): StatusPresentation {
  const fallen = now - state.lastFailAt < FAIL_FLASH_MS;
  const title = fallen
    ? `FAILED · ${state.lastFailTool}`
    : `${state.toolName || "tool"} · ${secsSince(state.phaseSince, now)}s`;
  const target = fallen
    ? state.lastFailTarget || state.lastFailTool
    : state.toolTarget || state.toolName;
  return {
    title,
    tone: fallen ? "error" : "warning",
    status: `${pulse} ${theme.fg(fallen ? "error" : "text", truncateToWidth(target || "tool", inner - 4))}`,
  };
}

function phasePresentation(
  theme: Theme,
  inner: number,
  now: number,
  pulse: string,
): StatusPresentation | undefined {
  const idle = state.phase === "idle";
  const fallen = now - state.lastFailAt < FAIL_FLASH_MS;
  if (state.phase === "tool" || (idle && fallen))
    return toolPresentation(theme, inner, now, pulse);
  if (state.phase === "thinking")
    return {
      title: `THINKING · ${secsSince(state.phaseSince, now)}s`,
      tone: "accent",
      status: `${pulse} deliberating`,
    };
  if (state.phase === "responding") {
    const tps = liveTps();
    return {
      title: `RESPONDING${tps ? ` · ${tps.toFixed(1)} tok/s` : ""}`,
      tone: "success",
      status: `${pulse} streaming`,
    };
  }
  if (state.compacting)
    return {
      title: `COMPACTING · ${state.compactBy || "context"} · ${secsSince(state.compactSince, now)}s`,
      tone: "warning",
      status: `${pulse} compacting context`,
    };
  return undefined;
}

function swapPresentation(
  now: number,
  pulse: string,
): StatusPresentation | undefined {
  if (state.phase !== "idle") return undefined;
  if (swap.state === "checking" || swap.state === "loading")
    return {
      title: swap.state === "loading"
        ? `LOADING · ${secsSince(swap.since)}s`
        : "CHECKING",
      tone: "warning",
      status: `${pulse} loading model`,
    };
  if (swap.state === "error")
    return {
      title: "OFFLINE",
      tone: "error",
      status: `${pulse} swap error`,
    };
  if (swap.state === "asleep")
    return {
      title: "ASLEEP · type to wake",
      tone: "muted",
      status: `${pulse} model asleep`,
    };
  if (swap.state === "ready" && now - swap.since < ONLINE_MS)
    return {
      title: swap.loadMs ? `ONLINE · ${fmtMs(swap.loadMs)}` : "ONLINE",
      tone: "success",
      status: `${pulse} model ready`,
    };
  return undefined;
}

function statusSection(
  panel: SidepanelPanel,
  inner: number,
): string[] {
  const now = Date.now();
  const pulse = animating(now)
    ? panel.theme.fg("accent", "◈")
    : panel.theme.fg("dim", "○");
  const presentation =
    phasePresentation(panel.theme, inner, now, pulse) ??
    swapPresentation(now, pulse) ?? {
      title: "STANDBY",
      tone: "muted" as ThemeColor,
      status: `${pulse} at rest`,
    };
  return [
    panelLabel(panel, {
      inner,
      label: presentation.title,
      left: "┌",
      right: "┐",
      tone: presentation.tone,
    }),
    panelFrame(panel, presentation.status, inner),
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

function piLensFileRows(
  panel: SidepanelPanel,
  inner: number,
): string[] {
  const out: string[] = [];
  const files = [...piLensState.files.entries()].sort(
    ([a], [b]) => a.localeCompare(b),
  );
  const currentFileHasIssues = files.some(
    ([path]) =>
      path === piLensState.currentFile ||
      displayPath(path) === displayPath(piLensState.currentFile),
  );
  if (piLensState.currentFile && !currentFileHasIssues)
    out.push(...panelFieldRows(panel, {
      label: "FILE",
      value: displayPath(piLensState.currentFile),
      inner,
      tone: "text",
    }));
  if (!files.length) return out;
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
  out.push(...panelFieldRows(panel, {
    label: "ISSUES",
    value: `${files.length} ${files.length === 1 ? "file" : "files"} · ${totalParts.join(" · ")}`,
    inner,
    tone: totals.errors ? "error" : "warning",
  }));
  for (const [path, counts] of files) {
    const parts: string[] = [];
    if (counts.errors) parts.push(`${counts.errors}E`);
    if (counts.warnings) parts.push(`${counts.warnings}W`);
    if (counts.info) parts.push(`${counts.info}I`);
    let tone: ThemeColor = "muted";
    if (counts.errors) tone = "error";
    else if (counts.warnings) tone = "warning";
    out.push(...panelFieldRows(panel, {
      label: "FILE",
      value: `${displayPath(path)} · ${parts.join(" ")}`,
      inner,
      tone,
    }));
  }
  return out;
}

function piLensStatusRows(
  panel: SidepanelPanel,
  inner: number,
  values: string[],
): string[] {
  const width = Math.max(1, inner - 1);
  const out: string[] = [];
  for (const value of values) {
    for (const line of wrapTextWithAnsi(value, width))
      out.push(panelFrame(panel, ` ${line}`, inner));
  }
  return out;
}

function piLensRows(
  panel: SidepanelPanel,
  inner: number,
  statuses: Array<[string, string]>,
): string[] {
  const values = piLensStatusValues(statuses);
  const technicalDebt = piLensTechnicalDebt(statuses);
  const languages = [...piLensState.languages]
    .sort((a, b) => a.localeCompare(b))
    .join(" ");
  const hasData =
    piLensState.available ||
    values.length > 0 ||
    Boolean(technicalDebt) ||
    Boolean(languages) ||
    Boolean(piLensState.currentFile) ||
    piLensState.files.size > 0;
  if (!hasData) return [];
  const out = [panelSep(panel, inner, "PI-LENS")];
  if (languages)
    out.push(...panelFieldRows(panel, {
      label: "LANG",
      value: languages,
      inner,
      tone: "muted",
    }));
  out.push(
    ...piLensFileRows(panel, inner),
    ...piLensStatusRows(panel, inner, values),
  );
  if (piLensState.available || technicalDebt)
    out.push(...panelFieldRows(panel, {
      label: "TDI",
      value: technicalDebt ?? "—",
      inner,
      tone: technicalDebt ? "warning" : "muted",
    }));
  return out;
}

interface TokenRateState {
  upstreamFresh: boolean;
  swapFresh: boolean;
  requestFresh: boolean;
  serverTps: number;
}

function freshRate(
  value: number,
  timestamp: number,
  now: number,
): boolean {
  return value > 0 &&
    timestamp > 0 &&
    now - timestamp < SERVER_RATE_STALE_MS;
}

function tokenRateState(now: number): TokenRateState {
  const upstreamFresh = freshRate(
    upstreamMetrics.tps,
    upstreamMetrics.tpsAt,
    now,
  );
  const swapFresh = freshRate(
    swap.srvTps,
    swap.srvTpsAt,
    now,
  );
  return {
    upstreamFresh,
    swapFresh,
    requestFresh:
      perf.start > 0 &&
      upstreamFresh &&
      upstreamMetrics.tpsAt >= perf.start,
    serverTps: upstreamFresh
      ? upstreamMetrics.tps
      : swap.srvTps,
  };
}

function tokenRateRow(
  panel: SidepanelPanel,
  inner: number,
): string {
  const active = perf.start > 0;
  const outputLive = active && perf.chars > 0;
  const rates = tokenRateState(Date.now());
  const serverFresh = rates.upstreamFresh || rates.swapFresh;
  let tps = perf.tps;
  if (rates.requestFresh) tps = upstreamMetrics.tps;
  else if (active && outputLive) tps = liveTps();
  else if (active) tps = 0;
  else if (serverFresh) tps = rates.serverTps;
  const tone: ThemeColor =
    rates.requestFresh || !outputLive ? "success" : "accent";
  let suffix = "";
  if (rates.requestFresh) suffix = " server";
  else if (outputLive) suffix = " ~live";
  else if (serverFresh) suffix = " server";
  const th = panel.theme;
  return panelFrame(
    panel,
    ` ${th.fg("dim", "TOK/S".padEnd(9))}${th.fg(tone, tps ? tps.toFixed(1) : "—")}${th.fg("dim", suffix)}`,
    inner,
  );
}

function promptLiveNow(now: number): boolean {
  return live.promptPps > 0 &&
    live.at > 0 &&
    now - live.at < LIVE_STALE_MS;
}

function upstreamPromptFresh(now: number): boolean {
  return upstreamMetrics.promptPps > 0 &&
    upstreamMetrics.promptPpsAt > 0 &&
    now - upstreamMetrics.promptPpsAt < SERVER_RATE_STALE_MS;
}

function swapPromptFresh(now: number): boolean {
  return swap.srvPps > 0 &&
    swap.srvPpsAt > 0 &&
    now - swap.srvPpsAt < SERVER_RATE_STALE_MS;
}

function promptRateValue(
  now: number,
): { pps: number; suffix: string } {
  const active = perf.start > 0;
  const promptLive = promptLiveNow(now);
  const upstreamFresh = upstreamPromptFresh(now);
  const swapFresh = swapPromptFresh(now);
  const requestFresh = active &&
    upstreamFresh &&
    upstreamMetrics.promptPpsAt >= perf.start;
  const liveEstimate = active &&
    !promptLive &&
    !perf.first &&
    perf.livePromptTokens > 0;
  if (promptLive)
    return {
      pps: live.promptPps,
      suffix: live.promptPpsServer ? " server" : " ~live",
    };
  if (requestFresh)
    return { pps: upstreamMetrics.promptPps, suffix: " server" };
  if (liveEstimate) {
    const elapsed = (now - perf.start) / 1000;
    return {
      pps: elapsed > 0 ? perf.livePromptTokens / elapsed : 0,
      suffix: " ~live",
    };
  }
  if (active) return { pps: 0, suffix: "" };
  if (upstreamFresh)
    return { pps: upstreamMetrics.promptPps, suffix: "" };
  if (swapFresh)
    return { pps: swap.srvPps, suffix: "" };
  return { pps: perf.pps, suffix: " ~est" };
}

function promptRateRow(
  panel: SidepanelPanel,
  inner: number,
): string {
  const result = promptRateValue(Date.now());
  return panelField(panel, {
    label: "PROMPT/S",
    value: result.pps
      ? `${result.pps.toFixed(1)}${result.suffix}`
      : "—",
    inner,
    tone: "muted",
  });
}

function promptProgressRow(
  panel: SidepanelPanel,
  inner: number,
): string | undefined {
  if (perf.start <= 0 || live.promptProcessed <= 0)
    return undefined;
  if (!live.promptProgressKnown || live.promptTotal <= 0)
    return panelField(panel, {
      label: "PROGRESS",
      value: `${fmtTokens(live.promptProcessed)} processed`,
      inner,
      tone: "muted",
    });
  const progress = Math.min(
    1,
    Math.max(0, live.promptProcessed / live.promptTotal),
  );
  const estimateMark = live.promptTotalEstimated ? "~" : "";
  return panelField(panel, {
    label: "PROGRESS",
    value: `${bar(panel.theme, Math.round(progress * 10), 10, "accent")} ${estimateMark}${Math.round(progress * 100)}% ${fmtTokens(live.promptProcessed)}/${fmtTokens(live.promptTotal)}`,
    inner,
    tone: "muted",
  });
}

function performanceDetailRows(
  panel: SidepanelPanel,
  inner: number,
): string[] {
  const out: string[] = [];
  const promptTotal = swap.cacheTokens + swap.inputTokens;
  if (swap.kvKnown && promptTotal) {
    out.push(panelField(panel, {
      label: "KV CACHE",
      value: `${fmtTokens(swap.cacheTokens)}/${fmtTokens(promptTotal)} hit ${Math.round((swap.cacheTokens / promptTotal) * 100)}%`,
      inner,
      tone: "muted",
    }));
  }
  out.push(
    panelField(panel, {
      label: "PEAK",
      value: perf.peakTps ? `${perf.peakTps.toFixed(1)} tok/s` : "—",
      inner,
      tone: "muted",
    }),
    panelField(panel, {
      label: "TTFT",
      value: perf.ttft ? fmtMs(perf.ttft) : "—",
      inner,
      tone: "muted",
    }),
  );
  let duration = "—";
  if (perf.start)
    duration = fmtMs(Math.max(1, Date.now() - perf.start));
  else if (perf.lastMs)
    duration = fmtMs(perf.lastMs);
  out.push(panelField(panel, {
    label: "DURATION",
    value: duration,
    inner,
    tone: "muted",
  }));
  const up = Math.floor((Date.now() - getSessionStart()) / 60000);
  out.push(panelField(panel, {
    label: "UPTIME",
    value: `${Math.floor(up / 60)}h ${String(up % 60).padStart(2, "0")}m`,
    inner,
    tone: "muted",
  }));
  return out;
}

function performanceRows(
  panel: SidepanelPanel,
  inner: number,
  compact: boolean,
): string[] {
  const out = [
    panelSep(panel, inner, "PERFORMANCE"),
    tokenRateRow(panel, inner),
    promptRateRow(panel, inner),
  ];
  const progress = promptProgressRow(panel, inner);
  if (progress) out.push(progress);
  if (!compact) out.push(...performanceDetailRows(panel, inner));
  return out;
}

function swapStatusRow(
  panel: SidepanelPanel,
  inner: number,
): string {
  const th = panel.theme;
  let status: string;
  if (swap.state === "ready")
    status = th.fg("success", "IN VRAM");
  else if (swap.state === "asleep")
    status = th.fg("muted", "ASLEEP");
  else if (swap.state === "error")
    status = th.fg("error", "OFFLINE");
  else if (swap.state === "loading")
    status = th.fg("warning", `LOADING ${secsSince(swap.since)}s`);
  else status = th.fg("warning", "CHECKING");
  const load = swap.state === "ready" && swap.loadMs
    ? th.fg("dim", ` load ${fmtMs(swap.loadMs)}`)
    : "";
  return panelFrame(
    panel,
    ` ${th.fg("dim", "STATUS".padEnd(9))}${status}${load}`,
    inner,
  );
}

function swapHardwareRows(
  panel: SidepanelPanel,
  inner: number,
): string[] {
  const th = panel.theme;
  const gib = (value: number) => value / 2 ** 30;
  const out: string[] = [];
  if (swap.state === "error")
    out.push(panelFrame(panel, " " + th.fg("error", swap.error), inner));
  for (const [index, gpu] of swap.gpus.entries()) {
    const percent = gpu.memTotal
      ? (gpu.memUsed / gpu.memTotal) * 100
      : 0;
    const utilizationTone = gpu.util > 0 ? "accent" : "muted";
    const temperatureTone = gpu.temp >= 80 ? "error" : "muted";
    out.push(
      panelFrame(
        panel,
        ` ${th.fg("dim", `VRAM${index}`.padEnd(9))}${bar(th, Math.round(percent / 10), 10, "accent")} ${th.fg("muted", `${gib(gpu.memUsed).toFixed(1)}/${Math.round(gib(gpu.memTotal))}G`)}`,
        inner,
      ),
      panelFrame(
        panel,
        ` ${th.fg("dim", `GPU${index}`.padEnd(9))}${th.fg(utilizationTone, `${Math.round(gpu.util)}%`.padEnd(6))}${th.fg(temperatureTone, `${Math.round(gpu.temp)}°C`.padEnd(7))}${th.fg("muted", `${Math.round(gpu.power)}W`)}`,
        inner,
      ),
    );
  }
  return out;
}

function swapResourceRows(
  panel: SidepanelPanel,
  inner: number,
): string[] {
  const gib = (value: number) => value / 2 ** 30;
  const out: string[] = [];
  if (swap.ramTotal)
    out.push(panelField(panel, {
      label: "RAM",
      value: `${gib(swap.ramUsed).toFixed(1)} / ${Math.round(gib(swap.ramTotal))}G`,
      inner,
      tone: "muted",
    }));
  if (swap.gpus.length)
    out.push(panelField(panel, {
      label: "ENERGY",
      value: `${(totalWh() / 1000).toFixed(3)} kWh`,
      inner,
      tone: "muted",
    }));
  return out;
}

function swapRows(
  panel: SidepanelPanel,
  inner: number,
  compact: boolean,
): string[] {
  if (!swap.base) return [];
  const section = swap.kind === "ninfer"
    ? "NINFER"
    : "LLAMA-SWAP";
  const out = [
    panelSep(panel, inner, section),
    swapStatusRow(panel, inner),
  ];
  if (compact) return [...out, costRow(panel, inner)];
  out.push(
    ...swapHardwareRows(panel, inner),
    ...swapResourceRows(panel, inner),
    costRow(panel, inner),
  );
  return out;
}

interface PanelCache {
  at: number;
  inner: number;
  compact: boolean;
  lines: string[];
}

export interface SidepanelPanel extends Component {
  theme: Theme;
  cache?: PanelCache;
  fillHeight?: () => number;
  invalidate(): void;
  dispose(): void;
}

export function renderSidepanelPanel(
  panel: SidepanelPanel,
  width: number,
): string[] {
  const inner = Math.max(24, width - 2);
  const now = Date.now();
  let cache = panel.cache;
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
    panel.cache = cache;
  }
  const bottom = panel.theme.fg(
    "border",
    "└" + "─".repeat(inner) + "┘",
  );
  const statuses = extensionStatusEntries();
  const lines = [
    ...statusSection(panel, inner),
    ...locationRows(panel, inner),
    ...cache.lines,
    ...extensionRows(panel, inner, statuses),
    ...piLensRows(panel, inner, statuses),
  ];
  const target = (panel.fillHeight?.() ?? 0) - 1;
  while (lines.length < target)
    lines.push(panelFrame(panel, "", inner));
  return [...lines, bottom].map((line) =>
    truncateToWidth(line, width),
  );
}

export function createSidepanelPanel(
  tui: TUI,
  theme: Theme,
): SidepanelPanel {
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastRequestedAt = 0;
  const panel: SidepanelPanel = {
    theme,
    cache: undefined,
    invalidate(): void {
      panel.cache = undefined;
    },
    dispose(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
    render(width: number): string[] {
      return renderSidepanelPanel(panel, width);
    }
  };
  timer = setInterval(() => {
    const now = Date.now();
    if (
      animating(now) ||
      now - lastRequestedAt >= 1000
    ) {
      lastRequestedAt = now;
      tui.requestRender();
    }
  }, 250);
  return panel;
}


