import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const reports = path.join(root, "output", "vitest");
await mkdir(reports, { recursive: true });
const stamp = new Date().toISOString().replaceAll(":", "-");
const runDir = await mkdtemp(path.join(reports, stamp + "-"));
console.log("Vitest reports:", runDir);

const log = createWriteStream(path.join(runDir, "console.log"));
await once(log, "open");
const entry = fileURLToPath(new URL("./vitest.mjs", import.meta.resolve("vitest/package.json")));
const child = spawn(process.execPath, [entry, "run", ...process.argv.slice(2)], {
  cwd: root,
  env: { ...process.env, MUSIC_LAB_VITEST_JSON: path.join(runDir, "results.json") },
  stdio: ["inherit", "pipe", "pipe"],
});
child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
const [code] = await once(child, "close");
log.end();
await once(log, "finish");
process.exitCode = code ?? 1;
