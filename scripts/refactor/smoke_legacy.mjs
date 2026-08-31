import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const expected = {
  main: "src/server.js",
  ghcpo: "./src/ghcpo.js",
  server: "./src/serverctl.js",
};

if (pkg.main !== expected.main) {
  console.error(`legacy main changed: ${pkg.main}`);
  process.exit(1);
}

if (pkg.bin?.ghcpo !== expected.ghcpo || pkg.bin?.["ghcpo-server"] !== expected.server) {
  console.error("legacy bins changed");
  process.exit(1);
}

const help = await run(process.execPath, ["src/ghcpo.js", "status", "--help"]);
if (help.code !== 0 || !help.stdout.includes("GitHub Copilot CLI Tool")) {
  console.error("legacy CLI help smoke failed");
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, main: pkg.main, bins: pkg.bin }));
