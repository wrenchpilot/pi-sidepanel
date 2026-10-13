import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  JsonObject,
  JsonValue,
  WireValue,
} from "./wire.js";
import {
  decodeWireValue,
  jsonNumber,
  jsonObject,
  jsonString,
} from "./wire.js";

export interface PiLensFindingCounts {
  errors: number;
  warnings: number;
  info: number;
}

export const piLensState = {
  currentFile: "",
  languages: new Set<string>(),
  files: new Map<string, PiLensFindingCounts>(),
  technicalDebt: undefined as string | undefined,
  available: false,
};

export function isTechnicalDebtStatus(
  key: string,
  value: string,
): boolean {
  const text = `${key} ${value}`.toLowerCase();
  return (
    text.includes("technical debt") ||
    /\btdi\b/.test(key.toLowerCase()) ||
    (text.includes("lens") && /\btdi\b/.test(text))
  );
}

export function isPiLensStatus(key: string): boolean {
  const normalized = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  return (
    normalized.startsWith("pi-lens") ||
    normalized.startsWith("lens-")
  );
}

export function emptyPiLensCounts(): PiLensFindingCounts {
  return { errors: 0, warnings: 0, info: 0 };
}

function piLensFallbackSeverity(
  fallback: "error" | "warning" | "info",
): keyof PiLensFindingCounts {
  if (fallback === "error") return "errors";
  if (fallback === "warning") return "warnings";
  return "info";
}

export function displayPath(target: string | undefined): string {
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
  if (/.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/.test(lower))
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

export function piLensTdiFromRecord(
  record: JsonObject,
): string | undefined {
  for (const key of [
    "tdi",
    "tdiScore",
    "tdi_score",
    "tdiIndex",
    "tdi_index",
    "technicalDebtIndex",
    "technical_debt_index",
    "technicalDebtScore",
    "technical_debt_score",
    "technicalDebt",
  ]) {
    const value = record[key];
    const number = jsonNumber(value);
    if (number !== undefined) return String(number);
    const text = jsonString(value);
    if (text) return text;
    const nested = jsonObject(value);
    if (!nested) continue;
    for (const nestedKey of ["score", "value", "index"]) {
      const nestedNumber = jsonNumber(nested[nestedKey]);
      if (nestedNumber !== undefined)
        return String(nestedNumber);
      const nestedText = jsonString(nested[nestedKey]);
      if (nestedText) return nestedText;
    }
  }
  return undefined;
}

function rememberPiLensPath(path: string): void {
  piLensState.currentFile = path;
  // A file edit invalidates its previous diagnostics. Keep the panel from
  // showing a warning that belonged to an older version of the file while
  // Pi-Lens is still preparing the replacement result.
  piLensState.files.delete(path);
  const language = piLensLanguage(path);
  if (language) piLensState.languages.add(language);
}

function addPiLensFinding(
  grouped: Map<string, PiLensFindingCounts>,
  finding: JsonValue,
  fallback: "error" | "warning" | "info",
  fallbackPath: string | undefined,
): void {
  const path = piLensFindingPath(finding) ?? fallbackPath;
  if (!path) return;
  const counts = grouped.get(path) ?? emptyPiLensCounts();
  counts[piLensFindingSeverity(finding, fallback)]++;
  grouped.set(path, counts);
  rememberPiLensPath(path);
}

function recordPiLensFileEntries(
  record: JsonObject,
  grouped: Map<string, PiLensFindingCounts>,
  primaryPath: string | undefined,
): void {
  const entries = Array.isArray(record.files) ? record.files : [];
  for (const value of entries) {
    const entry = jsonObject(value);
    const path = entry ? piLensFindingPath(entry) : undefined;
    if (!entry || !path) continue;
    const diagnostics = Array.isArray(entry.diagnostics)
      ? entry.diagnostics
      : [];
    if (!diagnostics.length) {
      grouped.set(path, emptyPiLensCounts());
      continue;
    }
    for (const finding of diagnostics)
      addPiLensFinding(grouped, finding, "info", path ?? primaryPath);
  }
}

function recordPiLensFindingArrays(
  record: JsonObject,
  grouped: Map<string, PiLensFindingCounts>,
  primaryPath: string | undefined,
): void {
  const diagnostics = Array.isArray(record.diagnostics)
    ? record.diagnostics
    : [];
  const findings = Array.isArray(record.findings)
    ? record.findings
    : [];
  if (diagnostics.length || findings.length) {
    for (const finding of diagnostics.length ? diagnostics : findings)
      addPiLensFinding(grouped, finding, "info", primaryPath);
    return;
  }
  const blockers = Array.isArray(record.blockers)
    ? record.blockers
    : [];
  const warnings = Array.isArray(record.warnings)
    ? record.warnings
    : [];
  for (const finding of blockers)
    addPiLensFinding(grouped, finding, "error", primaryPath);
  for (const finding of warnings)
    addPiLensFinding(grouped, finding, "warning", primaryPath);
}

function recordPiLensExplicitCounts(
  record: JsonObject,
  grouped: Map<string, PiLensFindingCounts>,
  primaryPath: string | undefined,
): void {
  if (grouped.size || !primaryPath) return;
  const errors =
    jsonNumber(record.errorCount) ?? jsonNumber(record.errors);
  const warnings =
    jsonNumber(record.warningCount) ?? jsonNumber(record.warnings);
  if (errors === undefined && warnings === undefined) return;
  grouped.set(primaryPath, {
    errors: Math.max(0, errors ?? 0),
    warnings: Math.max(0, warnings ?? 0),
    info: 0,
  });
}

function piLensHasSnapshot(record: JsonObject): boolean {
  return (
    (Array.isArray(record.files) && record.files.length > 0) ||
    Array.isArray(record.diagnostics) ||
    Array.isArray(record.findings) ||
    Array.isArray(record.blockers) ||
    Array.isArray(record.warnings)
  );
}

function applyPiLensCounts(
  grouped: Map<string, PiLensFindingCounts>,
  primaryPath: string | undefined,
  hasSnapshot: boolean,
): void {
  if (!grouped.size && hasSnapshot && primaryPath)
    grouped.set(primaryPath, emptyPiLensCounts());
  for (const [path, counts] of grouped) {
    if (counts.errors || counts.warnings || counts.info)
      piLensState.files.set(path, counts);
    else piLensState.files.delete(path);
  }
}

export function rememberPiLensEvent(data: JsonValue): void {
  const paths = piLensEventPaths(data);
  for (const path of paths) rememberPiLensPath(path);
  const record = jsonObject(data);
  if (!record) return;
  const primaryPath =
    jsonString(record.filePath) ?? paths[0];
  const grouped = new Map<string, PiLensFindingCounts>();
  recordPiLensFileEntries(record, grouped, primaryPath);
  recordPiLensFindingArrays(record, grouped, primaryPath);
  recordPiLensExplicitCounts(record, grouped, primaryPath);
  applyPiLensCounts(
    grouped,
    primaryPath,
    piLensHasSnapshot(record),
  );
}

export function handlePiLensEvent(
  raw: WireValue,
  repaint: () => void,
): void {
  const decoded = decodeWireValue(raw);
  if (decoded !== undefined) {
    const record = jsonObject(decoded);
    let scalar = jsonString(decoded);
    const number = jsonNumber(decoded);
    if (!scalar && number !== undefined)
      scalar = String(number);
    let technicalDebt: string | undefined;
    if (record) {
      technicalDebt = piLensTdiFromRecord(record);
    } else if (
      scalar &&
      isTechnicalDebtStatus("lens-tdi", scalar)
    ) {
      technicalDebt = scalar;
    }
    if (technicalDebt)
      piLensState.technicalDebt = technicalDebt;
    rememberPiLensEvent(decoded);
  }
  repaint();
}

export function registerPiLensEvents(
  pi: ExtensionAPI,
  repaint: () => void,
): void {
  const channels = [
    "pilens:files:touched",
    "pilens:format:start",
    "pilens:format:done",
    "pilens:autofix:start",
    "pilens:diagnostics",
    "pi-lens/analysis-complete",
    "pi-lens/findings",
    "pilens:tdi",
    "pilens:technical-debt",
    "pi-lens/tdi",
    "pi-lens/technical-debt",
  ];
  for (const channel of channels)
    pi.events.on(channel, (data) =>
      handlePiLensEvent(data as WireValue, repaint),
    );
}
