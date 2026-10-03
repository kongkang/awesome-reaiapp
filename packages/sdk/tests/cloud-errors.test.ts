import { expect, test } from "bun:test";
import { describeCloudError } from "../src/v1/cloud";
import { PLUGIN_BRIDGE_ERROR_CODES } from "../src/v1/error-codes";

test("G6 stable codes preserve the existing SDK taxonomy and retry policy", () => {
  for (const code of ["AI_NETWORK_ERROR", "FLOW_NETWORK_ERROR", "AI_SUBSCRIPTION_UNAVAILABLE"]) {
    expect(describeCloudError(code)).toEqual({ code: "unavailable", retryable: true });
    expect(PLUGIN_BRIDGE_ERROR_CODES as readonly string[]).toContain(code);
  }
  expect(describeCloudError("AI_SUBSCRIPTION_REQUIRED")).toEqual({ code: "unavailable", retryable: false });
  expect(PLUGIN_BRIDGE_ERROR_CODES as readonly string[]).toContain("AI_SUBSCRIPTION_REQUIRED");
  expect(describeCloudError("AI_PAYMENT_REQUIRED")).toEqual({ code: "unavailable", retryable: false });
  expect(describeCloudError("AI_SCOPE_UNAVAILABLE")).toEqual({ code: "permission_denied", retryable: false });
  expect(describeCloudError("NEW_UNKNOWN")).toEqual({ code: "unknown", retryable: false });
});
