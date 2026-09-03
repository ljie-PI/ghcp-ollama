import { describe, expect, it } from "vitest";
import { productionDependencySpecs } from "../../../scripts/refactor/production_dependency_specs.js";

describe("RM-22 production dependency cache closure", () => {
  it("contains the runtime closure and excludes SDK/build-only packages", async () => {
    const specs = await productionDependencySpecs();
    expect(specs).toContain("@hono/node-server@2.1.1");
    expect(specs).toContain("better-sqlite3@13.0.3");
    expect(specs).toContain("undici@8.10.0");
    expect(specs.some((spec) => spec.startsWith("openai@"))).toBe(false);
    expect(specs.some((spec) => spec.startsWith("vite@"))).toBe(false);
    expect(new Set(specs).size).toBe(specs.length);
  });
});
