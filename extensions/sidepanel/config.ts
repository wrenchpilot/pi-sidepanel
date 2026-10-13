import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  decodeWireValue,
  jsonObject,
  type WireValue,
} from "./wire.js";

export const PANEL_WIDTH = 34;
export const MIN_PANEL_WIDTH = 28;
export const MAX_PANEL_WIDTH = 72;

export interface SidepanelConfig {
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

export function clampPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return PANEL_WIDTH;
  return Math.min(
    MAX_PANEL_WIDTH,
    Math.max(MIN_PANEL_WIDTH, Math.round(width)),
  );
}

export function nonNegativeNumber(
  value: number | undefined,
): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function loadSidepanelConfig(): SidepanelConfig {
  try {
    const parsed = decodeWireValue(JSON.parse(
      readFileSync(SIDE_PANEL_CONFIG_PATH, "utf8"),
    ) as WireValue);
    const record = parsed && jsonObject(parsed);
    return record ? (record as SidepanelConfig) : {};
  } catch {
    return {};
  }
}

export function saveSidepanelConfig(
  cfg: SidepanelConfig,
): void {
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
