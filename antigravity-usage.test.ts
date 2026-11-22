import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAgyUsageCommand, type AgyUsageResult } from "./antigravity-usage.ts";

// Captured from `agy -p /usage --output-format json` (agy 1.5.13), descriptions trimmed.
const SAMPLE: AgyUsageResult = {
  status: "SUCCESS",
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.7739695310592651, reset_time: "2026-11-28T12:31:39Z" },
            { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.83864426612854, reset_time: "2026-11-22T22:55:06Z" },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            { id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 1, reset_time: "2026-11-29T22:33:35Z" },
            { id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-11-23T03:33:35Z" },
          ],
        },
        {
          name: "Gemini 4 Argon",
          buckets: [
            { id: "gemini-argon-wtu-weekly", name: "Gemini 4 Argon Weekly Limit", window: "weekly", remaining_fraction: 1, reset_time: "2026-11-29T22:33:35Z" },
          ],
        },
      ],
    },
  },
};

test("normalizes every /usage bucket with its window kind and model group", () => {
  const result = normalizeAgyUsageCommand(SAMPLE);
  assert.ok(result?.supported && result.usage.status === "ok");
  assert.deepEqual(result.usage.windows, [
    { label: "Weekly limit (Gemini)", usedPercent: 23, resetsAt: "2026-11-28T12:31:39Z", kind: "weekly", model: "Gemini" },
    { label: "5-hour limit (Gemini)", usedPercent: 16, resetsAt: "2026-11-22T22:55:06Z", kind: "five-hour", model: "Gemini" },
    { label: "Weekly limit (Claude & GPT)", usedPercent: 0, resetsAt: "2026-11-29T22:33:35Z", kind: "weekly", model: "Claude & GPT" },
    { label: "5-hour limit (Claude & GPT)", usedPercent: 0, resetsAt: "2026-11-23T03:33:35Z", kind: "five-hour", model: "Claude & GPT" },
    { label: "Weekly limit (Gemini 4 Argon)", usedPercent: 0, resetsAt: "2026-11-29T22:33:35Z", kind: "weekly", model: "Gemini 4 Argon" },
  ]);
});

test("reports a signed-out CLI as unauthenticated", () => {
  const result = normalizeAgyUsageCommand({ status: "ERROR", error: "You are not logged into Antigravity." });
  assert.deepEqual(result, { supported: true, usage: { status: "unauthenticated" } });
});

test("surfaces other CLI errors", () => {
  const result = normalizeAgyUsageCommand({ status: "ERROR", error: "Eligibility check failed: network unreachable" });
  assert.ok(result?.supported && result.usage.status === "error");
  assert.match(result.usage.message, /Eligibility check failed/);
});

test("returns null for output that is not a /usage result, so callers fall back", () => {
  assert.equal(normalizeAgyUsageCommand({ status: "SUCCESS" }), null);
  assert.equal(normalizeAgyUsageCommand({ status: "SUCCESS", command: { name: "models" } }), null);
});
