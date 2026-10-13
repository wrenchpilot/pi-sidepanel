export function normalizeServiceBase(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function parsePrometheusSamples(
  text: string,
): Map<string, number> {
  const samples = new Map<string, number>();
  const pattern =
    /^\s*([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+([-+0-9.eE]+)(?:\s+\d+)?\s*$/;
  for (const line of text.split("\n")) {
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

export function metricValue(
  samples: Map<string, number>,
  names: readonly string[],
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
