const NODE_24_MAJOR = 24;
const NODE_24_MIN_MINOR = 20;

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
  const minor = Number.parseInt(version.split(".")[1] ?? "", 10);

  if (!Number.isInteger(minor) || major < NODE_24_MAJOR || (major === NODE_24_MAJOR && minor < NODE_24_MIN_MINOR)) {
    throw new Error(`Node.js 24.20.0 or newer is required for the project toolchain; current ${version}`);
  }
}
