export function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function fmtMs(ms: number): string {
  return ms < 1000
    ? `${Math.round(ms)}ms`
    : `${(ms / 1000).toFixed(1)}s`;
}

export function secsSince(
  timestamp: number,
  now = Date.now(),
): number {
  return Math.max(
    0,
    Math.floor((now - timestamp) / 1000),
  );
}

export function usageTone(
  percent: number,
): "success" | "warning" | "error" {
  if (percent >= 80) return "error";
  if (percent >= 50) return "warning";
  return "success";
}

export function syncTone(
  percent: number,
): "success" | "warning" | "error" {
  if (percent >= 90) return "success";
  if (percent >= 70) return "warning";
  return "error";
}
import type {
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";


export function bar(
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
