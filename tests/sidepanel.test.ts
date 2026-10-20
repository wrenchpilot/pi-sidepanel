import assert from "node:assert/strict";
import test from "node:test";
import {
  metricValue,
  normalizeServiceBase,
  parsePrometheusSamples,
} from "../extensions/sidepanel/prometheus.ts";
import {
  fmtMs,
  fmtTokens,
} from "../extensions/sidepanel/format.ts";
import { estimateLivePromptRate } from "../extensions/sidepanel/prompt-rate.ts";

test("parsePrometheusSamples parses comments, labels, and timestamps", () => {
  const samples = parsePrometheusSamples(
    [
      "# HELP ignored",
      'llamacpp:tokens_predicted_total{model="demo"} 123',
      "llamacpp:prompt_tokens_total 45 1700000000",
      "llamacpp:tokens_predicted_total 7",
    ].join("\n"),
  );

  assert.equal(samples.get("llamacpp:tokens_predicted_total"), 130);
  assert.equal(samples.get("llamacpp:prompt_tokens_total"), 45);
  assert.equal(
    metricValue(samples, ["missing", "tokens_predicted_total"]),
    130,
  );
});

test("normalizeServiceBase removes trailing and v1 path segments", () => {
  assert.equal(
    normalizeServiceBase("http://localhost:8000/v1///"),
    "http://localhost:8000",
  );
});

test("live prompt rate uses cumulative tokens over elapsed processing time", () => {
  const rate = estimateLivePromptRate(8192, 1000, 29440);

  assert.ok(rate !== undefined);
  assert.ok(Math.abs(rate - 288) < 0.1);
});

test("live prompt rate waits for a meaningful sample", () => {
  assert.equal(estimateLivePromptRate(2048, 1000, 1100), undefined);
  assert.equal(estimateLivePromptRate(0, 1000, 2000), undefined);
});

test("format helpers preserve compact display units", () => {
  assert.equal(fmtTokens(999), "999");
  assert.equal(fmtTokens(1200), "1.2k");
  assert.equal(fmtMs(900), "900ms");
  assert.equal(fmtMs(1500), "1.5s");
});
