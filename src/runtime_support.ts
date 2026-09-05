export const MINIMUM_NODE_VERSION = "24.20.0";

const MINIMUM_MAJOR = 24;
const MINIMUM_MINOR = 20;
const MINIMUM_PATCH = 0;

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export function isSupportedNodeVersion(version = process.versions.node): boolean {
  const parsed = parseNodeVersion(version);
  if (parsed === null) {
    return false;
  }
  if (parsed.major !== MINIMUM_MAJOR) {
    return parsed.major > MINIMUM_MAJOR;
  }
  if (parsed.minor !== MINIMUM_MINOR) {
    return parsed.minor > MINIMUM_MINOR;
  }
  return parsed.patch >= MINIMUM_PATCH;
}

export function assertSupportedRuntime(version = process.versions.node): void {
  if (!isSupportedNodeVersion(version)) {
    throw new Error(`Node.js ${MINIMUM_NODE_VERSION} or newer is required; current ${version}`);
  }
}

function parseNodeVersion(version: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[+-].*)?$/u.exec(version);
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return null;
  }
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return { major, minor, patch };
}
