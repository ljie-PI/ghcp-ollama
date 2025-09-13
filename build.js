/* eslint-disable no-undef */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

console.log("Building ghcp-ollama...");

try {
  const distDir = path.join(process.cwd(), "dist");
  
  // Clean up existing dist directory
  if (fs.existsSync(distDir)) {
    console.log("Cleaning up existing dist directory...");
    fs.rmSync(distDir, { recursive: true, force: true });
  }
  
  // Create new dist directory
  fs.mkdirSync(distDir);

  console.log("Copying source files...");
  execSync("cp -r src dist/src", { stdio: "inherit" });
  execSync("cp package.json dist/", { stdio: "inherit" });
  execSync("cp README.md dist/", { stdio: "inherit" });
  execSync("cp LICENSE dist/", { stdio: "inherit" });
  execSync("cp eslint.config.js dist/", { stdio: "inherit" });

  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

  delete pkg.devDependencies;
  delete pkg.scripts.dev;
  delete pkg.scripts["lint:fix"];

  pkg.bin = {
    ghcpo: "./src/ghcpo.js",
    "ghcpo-server": "./src/serverctl.js",
  };

  fs.writeFileSync(
    path.join(distDir, "package.json"),
    JSON.stringify(pkg, null, 2),
  );

  console.log("Build completed successfully!");
  console.log("Distribution package created in dist/ directory");
  console.log("To publish to npm, run: cd dist && npm publish");
} catch (error) {
  console.error("Build failed:", error.message);
  process.exit(1);
}
