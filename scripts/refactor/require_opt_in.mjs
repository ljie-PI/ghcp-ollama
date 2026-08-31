const variable = process.argv[2];

if (!variable) {
  console.error("usage: node scripts/refactor/require_opt_in.mjs <ENV_VAR>");
  process.exit(2);
}

if (process.env[variable] !== "1") {
  const command = variable === "GHC_GATEWAY_LIVE_TESTS"
    ? "npm run test:live:sdk"
    : "npm run test:sdk:refactor";
  console.error(`${command} is manual-only; set ${variable}=1 to run it.`);
  process.exit(2);
}
