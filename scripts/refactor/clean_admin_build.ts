import { rm } from "node:fs/promises";
import path from "node:path";

const target = process.argv[2] === "all" ? path.resolve("dist") : path.resolve("dist", "admin");
await rm(target, { recursive: true, force: true });
