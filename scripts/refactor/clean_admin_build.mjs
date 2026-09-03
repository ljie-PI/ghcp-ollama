import { rm } from "node:fs/promises";

await rm(new URL("../../dist-refactor/admin", import.meta.url), { recursive: true, force: true });
