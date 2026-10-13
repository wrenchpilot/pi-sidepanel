import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentSettledEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionWidgetOptions,
  MessageEndEvent,
  MessageStartEvent,
  MessageUpdateEvent,
  ModelSelectEvent,
  ReadonlyFooterDataProvider,
  SessionCompactEvent,
  SessionStartEvent,
  SessionTreeEvent,
  Theme,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Container, HStack } from "@earendil-works/pi-tui";
import { loadSidepanelConfig, saveSidepanelConfig, clampPanelWidth, MAX_PANEL_WIDTH, MIN_PANEL_WIDTH, PANEL_WIDTH } from "./config.js";
import { showSwapStatus } from "./activity.js";
import { displayPath } from "./format.js";
import {
  configurePanelView,
  createSidepanelPanel,
  type FooterWidgetSnapshot,
  type SidepanelPanel,
} from "./panel-view.js";
import {
  configureSwapMonitor,
  contextUsage,
  beginRequestObservation,
  live,
  persistEnergy,
  preloadModel,
  probeModel,
  refreshLiveContext,
  refreshMetricsCycle,
  refreshMetricsWithActivity,
  resetMonitorState,
  swap,
  swapGet,
  totalWh,
  upstreamMetrics,
} from "./swap-monitor.js";
import type { JsonObject } from "./wire.js";

const LIVE_POLL_MS = 1000;
const BUSY_POLL_MS = 3000;
const IDLE_POLL_MS = 30000;
const TITLE_REFRESH_MS = 2000;
const MAX_ESTIMATED_PROMPT_PPS = 1_000_000;

interface RuntimeState {
  phase: "idle" | "thinking" | "responding" | "tool";
  phaseSince: number;
  toolName: string;
  toolTarget: string;
  turns: number;
  toolOk: number;
  toolFail: number;
  runStart: number;
  lastRunMs: number;
  compacting: boolean;
  compactSince: number;
  compactBy: string;
  hasSmartCompact: boolean;
  pruned: number;
  thinkCuts: number;
  lastFailAt: number;
  lastFailTool: string;
  lastFailTarget: string;
}

interface RuntimePerf {
  start: number;
  first: number;
  chars: number;
  livePromptTokens: number;
  liveOutputTokens: number;
  tps: number;
  tpsServer: boolean;
  pps: number;
  ttft: number;
  ttftServer: boolean;
  lastMs: number;
  peakTps: number;
}

interface RuntimeTokens {
  input: number;
  output: number;
  cacheRead: number;
  cost: number;
}

export interface SidepanelRuntimeDeps {
  state: RuntimeState;
  perf: RuntimePerf;
  tokens: RuntimeTokens;
  setPhase: (phase: RuntimeState["phase"]) => void;
  toolTarget: (args: JsonObject) => string;
  liveTps: () => number;
  animating: (now?: number) => boolean;
  getSessionStart: () => number;
  resetSessionState: () => void;
  recountSession: (ctx: ExtensionContext) => void;
  countAssistant: (message: AssistantMessage) => void;
}

let state: RuntimeState;
let perf: RuntimePerf;
let tokens: RuntimeTokens;
let setPhase: SidepanelRuntimeDeps["setPhase"];
let toolTarget: SidepanelRuntimeDeps["toolTarget"];
let currentLiveTps: SidepanelRuntimeDeps["liveTps"];
let isAnimating: SidepanelRuntimeDeps["animating"];
let getSessionStart: SidepanelRuntimeDeps["getSessionStart"];
let resetSessionState: SidepanelRuntimeDeps["resetSessionState"];
let recountSession: SidepanelRuntimeDeps["recountSession"];
let countAssistant: SidepanelRuntimeDeps["countAssistant"];
let liveCtx: ExtensionContext | undefined;
let footerDataRef: ReadonlyFooterDataProvider | undefined;

type FooterWidgetFactory = (
  tui: TUI,
  theme: Theme,
) => Component & { dispose?(): void };

type FooterFactory = (
  tui: TUI,
  theme: Theme,
  footerData: ReadonlyFooterDataProvider,
) => Component & { dispose?(): void };

type FooterWidgetContent =
  | string[]
  | FooterWidgetFactory
  | undefined;

interface FooterWidgetEntry extends FooterWidgetSnapshot {
  content: FooterWidgetContent;
  options?: ExtensionWidgetOptions;
}

const footerWidgets = new Map<string, FooterWidgetEntry>();
let customFooterFactory: FooterFactory | undefined;
let customFooterLines: string[] = [];

function footerWidgetSnapshots(): FooterWidgetSnapshot[] {
  const snapshots: FooterWidgetSnapshot[] = [];
  if (customFooterLines.length > 0)
    snapshots.push({ key: "custom-footer", lines: [...customFooterLines] });
  snapshots.push(
    ...[...footerWidgets.values()]
      .filter(({ lines }) => lines.length > 0)
      .map(({ key, lines }) => ({ key, lines: [...lines] })),
  );
  return snapshots;
}

export const ui = {
  compact: false,
  kwhPrice: undefined as number | undefined,
  currency: "EUR" as "EUR" | "USD",
};

let panelWidth = PANEL_WIDTH;

export function setPanelWidth(value: number): void {
  panelWidth = value;
}

export function configureSidepanelRuntime(
  deps: SidepanelRuntimeDeps,
): void {
  state = deps.state;
  perf = deps.perf;
  tokens = deps.tokens;
  setPhase = deps.setPhase;
  toolTarget = deps.toolTarget;
  currentLiveTps = deps.liveTps;
  isAnimating = deps.animating;
  getSessionStart = deps.getSessionStart;
  resetSessionState = deps.resetSessionState;
  recountSession = deps.recountSession;
  countAssistant = deps.countAssistant;
  configureSwapMonitor({
    state,
    perf,
    getLiveContext: () => liveCtx,
    repaint,
  });
  configurePanelView({
    state,
    swap,
    upstreamMetrics,
    live,
    perf,
    tokens,
    ui,
    getSessionStart,
    getLiveContext: () => liveCtx,
    getFooterData: () => footerDataRef,
    getFooterWidgets: () => footerWidgetSnapshots(),
    animating: isAnimating,
    liveTps: currentLiveTps,
    contextUsage,
    totalWh,
  });
}

export function getLiveContext(): ExtensionContext | undefined {
  return liveCtx;
}

export function repaintSidepanel(): void {
  repaint();
}

function animating(now = Date.now()): boolean {
  return isAnimating(now);
}

/* ──────────────────────────────────────────────────────── extension ── */

let tuiRef: TUI | undefined;
let panelHandle: ReturnType<TUI["showOverlay"]> | undefined;
let panel: SidepanelPanel | undefined;
let wrappedRoot: Component | undefined;
let regularChildren: Component[] | undefined;
let regularRoot: Component | undefined;
let restoreSelectionClamp: (() => void) | undefined;
let selectionSection: "left" | "panel" | undefined;
let titleDone = false;

interface SelectionPointLike {
  col?: number;
  scrollView?: unknown;
}

interface SelectionBoundsLike {
  start: SelectionPointLike;
  end: SelectionPointLike;
}

interface SelectionColumnsLike {
  start: number;
  end: number;
}

type SelectionColumnsFn = (
  ...args: [
    line: string,
    row: number,
    selection: SelectionBoundsLike,
    minColumn?: number,
    maxColumn?: number,
  ]
) => SelectionColumnsLike;

function clampPromptSelection(tui: TUI): void {
  // SAFETY: fullscreen TUI exposes this runtime selection method, but its
  // private implementation is intentionally absent from the public type.
  const target = tui as unknown as {
    getSelectionColumns?: SelectionColumnsFn;
  };
  if (!target.getSelectionColumns || restoreSelectionClamp)
    return;
  const original = target.getSelectionColumns.bind(tui);
  target.getSelectionColumns = (...args) => {
    const [line, row, selection, minColumn, maxColumn] =
      args;
    const columns = original(
      line,
      row,
      selection,
      minColumn,
      maxColumn,
    );
    if (
      selection.start.scrollView ||
      selection.end.scrollView ||
      tui.terminal.columns < panelWidth + 56
    )
      return columns;
    const boundary = Math.max(
      0,
      tui.terminal.columns - panelWidth - 1,
    );
    const section =
      selectionSection ??
      ((selection.start.col ?? 0) >= boundary
        ? "panel"
        : "left");
    if (section === "panel") {
      return {
        start: Math.max(columns.start, boundary),
        end: Math.max(columns.end, boundary),
      };
    }
    return {
      start: Math.min(columns.start, boundary),
      end: Math.min(columns.end, boundary),
    };
  };
  restoreSelectionClamp = () => {
    target.getSelectionColumns = original;
    restoreSelectionClamp = undefined;
  };
}

function windowTitle(cwd: string, done = false): string {
  return `${done ? "✓ " : ""}π - Sidepanel - ${displayPath(cwd)}`;
}

const showPanel = (theme: Theme) => {
  if (!tuiRef || panel || !panelEnabled) return;
  panel = createSidepanelPanel(tuiRef, theme);
  clampPromptSelection(tuiRef);

  // Fullscreen uses a private root that must be wrapped to reserve the
  // sidepanel column. This is the original side-by-side layout path.
  const t = tuiRef as unknown as {
    mode: string;
    layoutRoot?: Component;
    setLayoutRoot: (root: Component) => void;
  };
  if (t.mode === "fullscreen" && t.layoutRoot) {
    panel.fillHeight = () => tuiRef?.terminal.rows ?? 0;
    wrappedRoot = t.layoutRoot;
    t.setLayoutRoot.call(
      tuiRef,
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

  if (t.mode === "regular") {
    const originalChildren = [...tuiRef.children];
    const left = new Container();
    for (const child of originalChildren)
      left.addChild(child);
    regularChildren = originalChildren;
    regularRoot = new HStack(
      [
        {
          component: left,
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
    );
    panel.fillHeight = () => tuiRef?.terminal.rows ?? 0;
    tuiRef.children = [regularRoot];
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
  restoreSelectionClamp?.();
  if (regularChildren && tuiRef) {
    tuiRef.children = regularChildren;
    regularChildren = undefined;
    regularRoot = undefined;
  }
  if (wrappedRoot && tuiRef) {
    const t = tuiRef as unknown as {
      setLayoutRoot?: (root: Component) => void;
    };
    t.setLayoutRoot?.call(tuiRef, wrappedRoot);
    wrappedRoot = undefined;
  }
  panelHandle?.hide();
  panel?.dispose();
  panelHandle = undefined;
  panel = undefined;
};

let repaintQueued = false;

const repaint = () => {
  panel?.invalidate();
  if (repaintQueued) return;
  repaintQueued = true;
  queueMicrotask(() => {
    repaintQueued = false;
    tuiRef?.requestRender();
  });
};

let footerWidgetUi: ExtensionContext["ui"] | undefined;
let restoreFooterWidgetBridge: (() => void) | undefined;

type FooterWidgetSetter = (
  key: string,
  content: FooterWidgetContent,
  options?: ExtensionWidgetOptions,
) => void;

type FooterSetter = (factory: FooterFactory | undefined) => void;

function panelFooterFactory(
  _tui: TUI,
  _theme: Theme,
  footerData: ReadonlyFooterDataProvider,
): Component & { dispose?(): void } {
  footerDataRef = footerData;
  const unsubscribeBranch = footerData.onBranchChange(() => repaint());
  return {
    render: () => [],
    invalidate: () => {},
    dispose: unsubscribeBranch,
  };
}

/**
 * Pi extensions commonly use a below-editor widget as part of the footer
 * experience. Capture those widgets generically and render their lines in the
 * sidepanel, while leaving above-editor widgets and the sidepanel mount alone.
 */
function installFooterWidgetBridge(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  const uiContext = ctx.ui;
  if (footerWidgetUi === uiContext) return;
  restoreFooterWidgetBridge?.();

  const originalSetWidget = uiContext.setWidget;
  const invokeSetWidget = originalSetWidget.bind(uiContext) as unknown as FooterWidgetSetter;
  const originalSetFooter = uiContext.setFooter;
  const invokeSetFooter = originalSetFooter.bind(uiContext) as unknown as FooterSetter;
  const bridgedSetWidget = (
    key: string,
    content: FooterWidgetContent,
    options?: ExtensionWidgetOptions,
  ): void => {
    if (
      key === "sidepanel-hook" ||
      options?.placement === "aboveEditor"
    ) {
      invokeSetWidget(key, content, options);
      return;
    }

    if (content === undefined) {
      footerWidgets.delete(key);
      invokeSetWidget(key, content, options);
      repaint();
      return;
    }

    const entry: FooterWidgetEntry = {
      key,
      lines: Array.isArray(content) ? [...content] : [],
      content,
      options,
    };
    footerWidgets.set(key, entry);

    if (Array.isArray(content)) {
      // Keep the host widget mounted as an empty component so replacement and
      // removal continue to follow Pi's normal widget lifecycle.
      invokeSetWidget(key, [], options);
      repaint();
      return;
    }

    const nativeFactory = content;
    invokeSetWidget(
      key,
      (tui: TUI, theme: Theme) => {
        const native = nativeFactory(tui, theme);
        return {
          render(width: number): string[] {
            const lines = native.render(width);
            const changed =
              lines.length !== entry.lines.length ||
              lines.some((line, index) => line !== entry.lines[index]);
            if (changed) {
              entry.lines = [...lines];
              repaint();
            }
            return [];
          },
          invalidate(): void {
            native.invalidate();
          },
          dispose(): void {
            native.dispose?.();
          },
        };
      },
      options,
    );
  };

  const bridgedSetFooter = (factory: FooterFactory | undefined): void => {
    // Keep the sidepanel's own blank footer as a lifecycle anchor without
    // treating it as extension content to mirror.
    if (factory === panelFooterFactory) {
      invokeSetFooter(factory);
      return;
    }

    customFooterFactory = factory;
    customFooterLines = [];
    if (factory === undefined) {
      // The native footer stays suppressed while the sidepanel is active.
      invokeSetFooter(panelFooterFactory);
      repaint();
      return;
    }

    invokeSetFooter((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
      footerDataRef = footerData;
      const native = factory(tui, theme, footerData);
      return {
        render(width: number): string[] {
          const lines = native.render(width);
          const changed =
            lines.length !== customFooterLines.length ||
            lines.some((line, index) => line !== customFooterLines[index]);
          if (changed) {
            customFooterLines = [...lines];
            repaint();
          }
          return [];
        },
        invalidate(): void {
          native.invalidate();
        },
        dispose(): void {
          native.dispose?.();
        },
      };
    });
    repaint();
  };

  uiContext.setWidget = bridgedSetWidget as typeof uiContext.setWidget;
  uiContext.setFooter = bridgedSetFooter as typeof uiContext.setFooter;
  footerWidgetUi = uiContext;
  restoreFooterWidgetBridge = () => {
    for (const entry of footerWidgets.values())
      invokeSetWidget(entry.key, entry.content, entry.options);
    invokeSetFooter(customFooterFactory);
    footerWidgets.clear();
    customFooterFactory = undefined;
    customFooterLines = [];
    uiContext.setWidget = originalSetWidget;
    uiContext.setFooter = originalSetFooter;
    if (footerWidgetUi === uiContext) footerWidgetUi = undefined;
    restoreFooterWidgetBridge = undefined;
  };
}

function rememberSelectionSection(data: string): void {
  if (!data.startsWith("\x1b[<") || !tuiRef) return;
  const release = data.endsWith("m");
  if (release) return;
  const fields = data.slice(3, -1).split(";");
  if (fields.length !== 3) return;
  const button = Number(fields[0]);
  if ((button & 3) !== 0 || (button & 32) !== 0) return;
  const column = Number(fields[1]);
  const boundary = tuiRef.terminal.columns - panelWidth - 1;
  selectionSection =
    column >= boundary ? "panel" : "left";
}

let panelEnabled = true;
let metricsTimer: ReturnType<typeof setInterval> | undefined;
let unsubscribeInput: (() => void) | undefined;
let lastPoll = 0;
let titleTimer: ReturnType<typeof setInterval> | undefined;
let liveTimer: ReturnType<typeof setInterval> | undefined;
const runningTools = new Map<string, { name: string; target: string }>();

function disableChrome(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  const restoreBridge = restoreFooterWidgetBridge;
  restoreBridge?.();
  hidePanel();
  ctx.ui.setWidget("sidepanel-hook", undefined);
  ctx.ui.setHeader(undefined);
  if (!restoreBridge) ctx.ui.setFooter(undefined);
  footerDataRef = undefined;
}

function applyChrome(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  if (!panelEnabled) {
    disableChrome(ctx);
    return;
  }
  installFooterWidgetBridge(ctx);
  ctx.ui.setWidget(
    "sidepanel-hook",
    (tui: TUI, theme: Theme) => {
      tuiRef = tui;
      queueMicrotask(() => showPanel(theme));
      return { render: () => [], invalidate: () => {} };
    },
  );
  ctx.ui.setHeader(undefined);
  ctx.ui.setFooter(panelFooterFactory);
  ctx.ui.setTitle(windowTitle(ctx.cwd, titleDone));
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
  if (
    event &&
    (event.type === "text_start" ||
      event.type === "thinking_start" ||
      event.type === "text_delta" ||
      event.type === "thinking_delta") &&
    !perf.first
  )
    perf.first = Date.now();
  if (
    event &&
    (event.type === "text_delta" ||
      event.type === "thinking_delta") &&
    event.delta
  )
    perf.chars += event.delta.length;
  if (event && "partial" in event) {
    const usage = event.partial.usage;
    if (!usage) return;
    const promptTokens =
      usage.input + usage.cacheRead + usage.cacheWrite;
    if (promptTokens > 0)
      perf.livePromptTokens = promptTokens;
    if (usage.output > 0)
      perf.liveOutputTokens = usage.output;
  }
}

function recordPromptRate(
  message: AssistantMessage,
  firstTokenMs: number,
  responseMs: number,
): void {
  const promptTokens =
    (message.usage?.input ?? 0) +
    (message.usage?.cacheRead ?? 0) +
    (message.usage?.cacheWrite ?? 0) ||
    perf.livePromptTokens;
  if (
    promptTokens <= 0 ||
    firstTokenMs <= 0 ||
    firstTokenMs > responseMs
  )
    return;
  const estimate = promptTokens / (firstTokenMs / 1000);
  if (
    Number.isFinite(estimate) &&
    estimate <= MAX_ESTIMATED_PROMPT_PPS
  )
    perf.pps = estimate;
}

function recordOutputRate(
  message: AssistantMessage,
  firstTokenMs: number,
  responseMs: number,
): void {
  // Do not turn character count into a completed-response token count. It
  // is useful for the explicitly-marked live estimate, but not for a final
  // performance value.
  const outputTokens =
    message.usage?.output ||
    perf.liveOutputTokens;
  const generationMs =
    firstTokenMs > 0 && firstTokenMs < responseMs
      ? responseMs - firstTokenMs
      : responseMs;
  if (outputTokens <= 0 || generationMs <= 0) return;
  const rate = outputTokens / (generationMs / 1000);
  // Server-backed models must not replace their authoritative rate with a
  // slower client wall-clock estimate. Non-server providers still get the
  // client fallback.
  if (!perf.tpsServer && !swap.kind) {
    perf.tps = rate;
    perf.peakTps = Math.max(perf.peakTps, rate);
  }
}

function recordAssistantPerformance(
  message: AssistantMessage,
): void {
  // The event is normally paired with message_start, but using the message's
  // request timestamp keeps metrics working for providers/extensions that do
  // not emit that event to every subscriber.
  const requestStart = perf.start || message.timestamp;
  if (!requestStart) return;
  const end = Date.now();
  perf.lastMs =
    message.durationMs ?? Math.max(1, end - requestStart);
  const firstTokenMs = perf.first
    ? Math.max(0, perf.first - requestStart)
    : 0;
  const responseMs = Math.max(1, perf.lastMs);
  recordPromptRate(message, firstTokenMs, responseMs);
  recordOutputRate(message, firstTokenMs, responseMs);
  // A llama-server timing is authoritative. Only use the client event timing
  // when no server-side TTFT was observed for this response.
  if (firstTokenMs > 0 && !perf.ttftServer)
    perf.ttft = firstTokenMs;
  perf.start = 0;
}

function refreshMetricsAfterMessage(
  messageTimestamp: number,
): void {
  // llama-swap writes the activity row after the response finishes. Retry a
  // few times so a slow store flush does not leave the previous request on
  // screen indefinitely.
  for (const delay of [300, 900, 1800]) {
    setTimeout(() => {
      void refreshMetricsWithActivity(messageTimestamp)
        .then(repaint)
        .catch(() => undefined);
    }, delay);
  }
}

interface ChromeActions {
  apply(ctx: ExtensionContext): void;
  disable(ctx: ExtensionContext): void;
}

function togglePanel(
  ctx: ExtensionContext,
  chrome: ChromeActions,
): void {
  panelEnabled = !panelEnabled;
  if (panelEnabled) chrome.apply(ctx);
  else chrome.disable(ctx);
  ctx.ui.notify(
    `Side panel ${panelEnabled ? "enabled" : "disabled"}`,
    "info",
  );
}

function toggleCompact(ctx: ExtensionContext): void {
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
}

function configurePanelWidth(
  ctx: ExtensionContext,
  value: string | undefined,
  chrome: ChromeActions,
): void {
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
    chrome.apply(ctx);
  }
  ctx.ui.notify(`Side panel width: ${panelWidth}`, "info");
}

function disablePanel(
  ctx: ExtensionContext,
  chrome: ChromeActions,
): void {
  panelEnabled = false;
  chrome.disable(ctx);
  ctx.ui.notify("Sidepanel chrome disabled", "info");
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

function resetSessionView(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): void {
  resetSessionState();
  panelEnabled = true;
  titleDone = false;
  runningTools.clear();
  liveCtx = ctx;
  recountSession(ctx);
  state.hasSmartCompact = pi.getCommands().some(
    (command: { name: string }) =>
      command.name?.replace(/^\/?/, "") === "smart-compact",
  );
}

function startSessionTimers(
  ctx: ExtensionContext,
): void {
  applyChrome(ctx);
  void probeModel(ctx).then(() => repaint()).catch(() => undefined);
  clearInterval(metricsTimer);
  lastPoll = 0;
  metricsTimer = setInterval(() => {
    const now = Date.now();
    if (!animating(now) && now - lastPoll < IDLE_POLL_MS)
      return;
    lastPoll = now;
    void refreshMetricsCycle()
      .then(repaint)
      .catch(() => undefined);
  }, BUSY_POLL_MS);
  clearInterval(liveTimer);
  liveTimer = setInterval(() => {
    if (perf.start > 0 || state.phase !== "idle")
      void refreshLiveContext()
        .then(repaint)
        .catch(() => undefined);
  }, LIVE_POLL_MS);
}

function bindSessionUi(ctx: ExtensionContext): void {
  unsubscribeInput?.();
  unsubscribeInput = ctx.ui.onTerminalInput((data: string) => {
    rememberSelectionSection(data);
    if (titleDone) {
      titleDone = false;
      ctx.ui.setTitle(windowTitle(ctx.cwd));
    }
    if (swap.state === "asleep" && liveCtx)
      void preloadModel(liveCtx).catch(() => undefined);
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
}

export function registerSessionEvents(pi: ExtensionAPI): void {
  pi.on(
    "session_start",
    (
      _event: SessionStartEvent,
      ctx: ExtensionContext,
    ) => {
      resetSessionView(pi, ctx);
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
      // Keep the last completed values visible while the new model connects.
      // They are replaced only when fresh server/client measurements arrive.
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
    resetMonitorState();
    runningTools.clear();
    state.toolName = "";
    state.toolTarget = "";
    hidePanel();
    restoreFooterWidgetBridge?.();
    tuiRef = undefined;
    liveCtx = undefined;
    footerDataRef = undefined;
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
}

export function registerMessageEvents(pi: ExtensionAPI): void {
  pi.on(
    "message_start",
    (event: MessageStartEvent) => {
      if (event.message.role !== "assistant") return;
      perf.start = Date.now();
      perf.first = 0;
      perf.chars = 0;
      perf.livePromptTokens = 0;
      perf.liveOutputTokens = 0;
      perf.tpsServer = false;
      perf.ttftServer = false;
      beginRequestObservation(perf.start);
      live.promptTokens = 0;
      live.promptAt = 0;
      live.tps = 0;
      live.tpsAt = 0;
      live.tpsServer = false;
      live.promptPps = 0;
      live.promptPpsServer = false;
      live.promptProcessing = false;
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
    live.promptProcessing = false;
    repaint();
    refreshMetricsAfterMessage(message.timestamp);
  });
}

export function registerToolEvents(pi: ExtensionAPI): void {
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
}

export function registerCompactionEvents(pi: ExtensionAPI): void {
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
}

export function registerSidepanelCommand(pi: ExtensionAPI): void {
  const chromeActions: ChromeActions = {
    apply: applyChrome,
    disable: disableChrome,
  };
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
      const value = prefix.trimStart().toLowerCase();
      return table.flatMap(([name, description]) =>
        name.startsWith(value)
          ? [{ value: name, label: name, description }]
          : [],
      );
    },
    handler: async (
      args: string,
      ctx: ExtensionContext,
    ) => {
      const arg = args.trim();
      const [command, value] = arg.split(/\s+/, 2);
      if (arg === "panel") {
        togglePanel(ctx, chromeActions);
        return;
      }
      if (arg === "compact") {
        toggleCompact(ctx);
        return;
      }
      if (command === "width") {
        configurePanelWidth(ctx, value, chromeActions);
        return;
      }
      if (arg === "status") {
        await showSwapStatus(ctx, {
          enabled: swap.kind === "llama-swap",
          get: swapGet,
        });
        return;
      }
      if (arg === "off") {
        disablePanel(ctx, chromeActions);
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


