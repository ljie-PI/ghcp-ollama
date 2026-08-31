const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);

if (!Number.isInteger(major) || major < 24) {
  console.error(`Node.js 24 or newer is required for the refactor toolchain; current ${process.versions.node}`);
  process.exit(1);
}
