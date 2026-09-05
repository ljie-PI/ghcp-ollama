import { describe, expect, it } from "vitest";
import { productionDependencySpecs } from "../../scripts/tooling/production_dependency_specs.js";

describe("production dependency cache closure", () => {
  it("contains the runtime closure and excludes SDK/build-only packages", async () => {
    const specs = await productionDependencySpecs();
    expect(specs).toContain("@hono/node-server@2.1.1");
    expect(specs.some((spec) => /^(?:better-sqlite3|node-gyp|bindings|node-addon-api)@/u.test(spec))).toBe(false);
    expect(specs).toContain("undici@8.10.0");
    expect(specs.some((spec) => spec.startsWith("openai@"))).toBe(false);
    expect(specs.some((spec) => spec.startsWith("vite@"))).toBe(false);
    expect(new Set(specs).size).toBe(specs.length);
  });
});
