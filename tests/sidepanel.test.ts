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

test("format helpers preserve compact display units", () => {
  assert.equal(fmtTokens(999), "999");
  assert.equal(fmtTokens(1200), "1.2k");
  assert.equal(fmtMs(900), "900ms");
  assert.equal(fmtMs(1500), "1.5s");
});
