import { rm } from "node:fs/promises";
import path from "node:path";

await rm(path.resolve("dist-refactor", "admin"), { recursive: true, force: true });
