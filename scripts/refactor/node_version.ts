const NODE_24_MAJOR = 24;

export function currentNodeMajor(version = process.versions.node): number {
  const [major] = version.split(".");
  const parsed = Number.parseInt(major ?? "", 10);

  if (!Number.isInteger(parsed)) {
    throw new Error(`invalid Node.js version: ${version}`);
  }

  return parsed;
}

export function assertNode24(version = process.versions.node): void {
  const major = currentNodeMajor(version);

  if (major < NODE_24_MAJOR) {
    throw new Error(`Node.js 24 or newer is required for the refactor toolchain; current ${version}`);
  }
}
