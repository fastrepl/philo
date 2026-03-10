import { spawn, } from "node:child_process";
import { cpSync, mkdirSync, } from "node:fs";
import { dirname, extname, join, resolve, } from "node:path";
import { fileURLToPath, } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url,),);
const appDir = resolve(scriptDir, "..",);
const srcTauriDir = resolve(appDir, "src-tauri",);

const args = process.argv.slice(2,);
const [command, ...rest] = args;

function run(cmd, cmdArgs, options = {},) {
  return new Promise((resolvePromise, rejectPromise,) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: appDir,
      stdio: "inherit",
      shell: process.platform === "win32",
      ...options,
    },);

    child.on("exit", (code,) => {
      if ((code ?? 1) === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`${cmd} ${cmdArgs.join(" ",)} exited with ${code}`,),);
      }
    },);
  },);
}

function capture(cmd, cmdArgs,) {
  return new Promise((resolvePromise, rejectPromise,) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, cmdArgs, {
      cwd: appDir,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe",],
    },);

    child.stdout.on("data", (chunk,) => {
      stdout += chunk;
    },);
    child.stderr.on("data", (chunk,) => {
      stderr += chunk;
    },);
    child.on("exit", (code,) => {
      if ((code ?? 1) === 0) {
        resolvePromise(stdout,);
      } else {
        rejectPromise(new Error(stderr || `${cmd} ${cmdArgs.join(" ",)} exited with ${code}`,),);
      }
    },);
  },);
}

async function buildSidecar(mode,) {
  const cargoArgs = ["build", "--manifest-path", resolve(srcTauriDir, "Cargo.toml",), "--bin", "philo-cli",];
  if (mode === "release") {
    cargoArgs.push("--release",);
  }
  await run("cargo", cargoArgs, { cwd: srcTauriDir, },);

  if (mode !== "release") return;

  const rustcVersion = await capture("rustc", ["-vV",],);
  const hostTriple = rustcVersion
    .split("\n",)
    .map((line,) => line.trim())
    .find((line,) => line.startsWith("host: ",))
    ?.slice("host: ".length,);
  if (!hostTriple) {
    throw new Error("Could not determine rustc host triple.",);
  }

  const binaryName = process.platform === "win32" ? "philo-cli.exe" : "philo-cli";
  const builtBinary = resolve(srcTauriDir, "target", "release", binaryName,);
  const targetBinary = join(
    srcTauriDir,
    "binaries",
    `${extname(binaryName,) ? binaryName.slice(0, -extname(binaryName,).length,) : binaryName}-${hostTriple}${
      extname(binaryName,)
    }`,
  );
  mkdirSync(dirname(targetBinary,), { recursive: true, },);
  cpSync(builtBinary, targetBinary,);
}

const tauriArgs = command === "dev"
  ? ["dev", "--config", resolve(appDir, "src-tauri", "tauri.dev.conf.json",), ...rest,]
  : args;

try {
  if (command === "dev") {
    await buildSidecar("debug",);
  } else if (command === "build") {
    await buildSidecar("release",);
  }

  await run("pnpm", ["exec", "tauri", ...tauriArgs,],);
} catch (error) {
  console.error(error instanceof Error ? error.message : error,);
  process.exit(1,);
}
