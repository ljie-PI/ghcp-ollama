import { describe, expect, it } from "vitest";
import {
  MINIMUM_NODE_VERSION,
  assertSupportedRuntime,
  isSupportedNodeVersion,
} from "../../src/runtime_support.js";

describe("production runtime support", () => {
  it("keeps the documented Node.js floor at 24.20.0", () => {
    expect(MINIMUM_NODE_VERSION).toBe("24.20.0");

    for (const version of ["24.0.0", "24.1.0", "24.2.0", "24.19.9", "23.99.99"]) {
      expect(isSupportedNodeVersion(version), version).toBe(false);
      expect(() => assertSupportedRuntime(version)).toThrow(/24\.20\.0/u);
    }

    for (const version of ["24.20.0", "24.21.0", "25.0.0", "26.8.1"]) {
      expect(isSupportedNodeVersion(version), version).toBe(true);
      expect(() => assertSupportedRuntime(version)).not.toThrow();
    }
  });
});
