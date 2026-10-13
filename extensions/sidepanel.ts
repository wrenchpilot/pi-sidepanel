/**
 * Side Panel — a lightweight stats panel for the pi TUI.
 */

import type {
  AssistantMessage,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  PANEL_WIDTH,
  clampPanelWidth,
  loadSidepanelConfig,
  nonNegativeNumber,
} from "./sidepanel/config.js";
import { discoverNinfer } from "./sidepanel/ninfer.js";
import {
  jsonObject,
  jsonString,
  type JsonObject,
} from "./sidepanel/wire.js";
import {
  configureSidepanelRuntime,
  registerCompactionEvents,
  registerMessageEvents,
  registerSessionEvents,
  registerSidepanelCommand,
  registerToolEvents,
  setPanelWidth,
  ui,
} from "./sidepanel/runtime.js";
import {
  resetMonitorState,
  swap,
} from "./sidepanel/swap-monitor.js";

/* ──────────────────────────────────────────────────────── constants ── */

const FAIL_FLASH_MS = 2500;
const ONLINE_MS = 3000;

let sessionStart = Date.now();

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

function animating(now = Date.now()): boolean {
  return (
    state.phase !== "idle" ||
    swap.state === "checking" ||
    swap.state === "loading" ||
    swap.state === "error" ||
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

const perf = {
  start: 0,
  first: 0,
  chars: 0,
  livePromptTokens: 0,
  liveOutputTokens: 0,
  tps: 0,
  tpsServer: false,
  pps: 0,
  ttft: 0,
  ttftServer: false,
  lastMs: 0,
  peakTps: 0,
};

function liveTps(): number {
  if (perf.start > 0 || state.phase !== "idle") {
    const anchor = perf.first || perf.start;
    const s = anchor ? (Date.now() - anchor) / 1000 : 0;
    if (s > 0.3) {
      const outputTokens =
        perf.liveOutputTokens > 0
          ? perf.liveOutputTokens
          : perf.chars / 4;
      if (outputTokens > 0)
        return outputTokens / s;
    }
    return 0;
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

function resetSessionState(): void {
  sessionStart = Date.now();
  resetMonitorState();
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
    tpsServer: false,
    pps: 0,
    ttft: 0,
    ttftServer: false,
    lastMs: 0,
    peakTps: 0,
  });
}

export default async function (pi: ExtensionAPI) {
  const sidepanelCfg = loadSidepanelConfig();

  ui.compact = sidepanelCfg.ui?.compact === true;
  ui.kwhPrice = nonNegativeNumber(
    sidepanelCfg.ui?.kwhPrice,
  );
  setPanelWidth(clampPanelWidth(
    nonNegativeNumber(sidepanelCfg.ui?.panelWidth) ??
      PANEL_WIDTH,
  ));
  ui.currency =
    sidepanelCfg.ui?.currency === "USD" ? "USD" : "EUR";
  swap.diskWh = nonNegativeNumber(sidepanelCfg.totalWh) ?? 0;

  configureSidepanelRuntime({
    state,
    perf,
    tokens,
    setPhase,
    toolTarget,
    liveTps,
    animating,
    getSessionStart: () => sessionStart,
    resetSessionState,
    recountSession,
    countAssistant,
  });

  registerSessionEvents(pi);

  registerMessageEvents(pi);
  registerToolEvents(pi);
  registerCompactionEvents(pi);

  registerSidepanelCommand(pi);

  // Register the synchronous session/UI wiring before waiting on optional
  // remote model discovery so startup UI and footer status handling are not
  // delayed by a network probe.
  await discoverNinfer(pi, sidepanelCfg.ninfer);
}
