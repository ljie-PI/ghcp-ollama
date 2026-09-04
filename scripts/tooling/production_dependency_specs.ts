import { readFile } from "node:fs/promises";

interface LockPackage {
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

interface PackageLock {
  readonly packages: Readonly<Record<string, LockPackage>>;
}

export async function productionDependencySpecs(lockPath = "package-lock.json"): Promise<readonly string[]> {
  const lock = JSON.parse(await readFile(lockPath, "utf8")) as PackageLock;
  const root = lock.packages[""];
  if (root === undefined) throw new Error("package lock has no root package");
  const pending = Object.keys(root.dependencies ?? {});
  const visited = new Set<string>();
  const specs: string[] = [];
  while (pending.length > 0) {
    const name = pending.shift();
    if (name === undefined || visited.has(name)) continue;
    visited.add(name);
    const entry = lock.packages[`node_modules/${name}`];
    if (entry?.version === undefined) throw new Error(`package lock is missing production dependency ${name}`);
    specs.push(`${name}@${entry.version}`);
    pending.push(...Object.keys(entry.dependencies ?? {}), ...Object.keys(entry.optionalDependencies ?? {}));
  }
  return specs.sort();
}

if (process.argv[1]?.endsWith("production_dependency_specs.ts")) {
  process.stdout.write(`${(await productionDependencySpecs()).join("\n")}\n`);
}
