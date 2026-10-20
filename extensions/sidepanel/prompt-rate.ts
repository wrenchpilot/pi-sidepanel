export const MIN_PROMPT_SAMPLE_MS = 250;

/** Estimate active prompt throughput from cumulative processed tokens. */
export function estimateLivePromptRate(
  processedTokens: number,
  startedAt: number,
  now: number,
): number | undefined {
  if (
    !Number.isFinite(processedTokens) ||
    processedTokens <= 0 ||
    !Number.isFinite(startedAt) ||
    startedAt <= 0 ||
    !Number.isFinite(now)
  )
    return undefined;

  const elapsedMs = now - startedAt;
  if (elapsedMs < MIN_PROMPT_SAMPLE_MS) return undefined;
  return processedTokens / (elapsedMs / 1000);
}
