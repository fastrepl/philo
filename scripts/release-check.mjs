import { spawnSync, } from "node:child_process";
import { dirname, resolve, } from "node:path";
import { fileURLToPath, } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url,),), "..",);
const tauriDir = resolve(rootDir, "apps", "desktop", "src-tauri",);

const steps = [
  {
    label: "Check formatting",
    command: "pnpm",
    args: ["run", "fmt:check",],
    cwd: rootDir,
  },
  {
    label: "Typecheck desktop",
    command: "pnpm",
    args: ["--filter", "@philo/desktop", "typecheck",],
    cwd: rootDir,
  },
  {
    label: "Typecheck landing",
    command: "pnpm",
    args: ["--filter", "@philo/landing", "typecheck",],
    cwd: rootDir,
  },
  {
    label: "Build desktop frontend",
    command: "pnpm",
    args: ["run", "build",],
    cwd: rootDir,
  },
  {
    label: "Check Rust formatting",
    command: "cargo",
    args: ["fmt", "--check",],
    cwd: tauriDir,
  },
  {
    label: "Check Rust compile",
    command: "cargo",
    args: ["check",],
    cwd: tauriDir,
  },
  {
    label: "Check Rust lints",
    command: "cargo",
    args: ["clippy", "--", "-D", "warnings",],
    cwd: tauriDir,
  },
  {
    label: "Run Rust tests",
    command: "cargo",
    args: ["test",],
    cwd: tauriDir,
  },
  {
    label: "Build desktop app",
    command: "cargo",
    args: ["build",],
    cwd: tauriDir,
  },
];

for (const step of steps) {
  console.log(`\n==> ${step.label}`,);

  const result = spawnSync(step.command, step.args, {
    cwd: step.cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  },);

  if (result.status !== 0) {
    process.exit(result.status ?? 1,);
  }
}
