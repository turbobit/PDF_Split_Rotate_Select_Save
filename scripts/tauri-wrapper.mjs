import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const tauriBin = process.platform === "win32"
  ? resolve(rootDir, "node_modules", ".bin", "tauri.cmd")
  : resolve(rootDir, "node_modules", ".bin", "tauri");

const args = process.argv.slice(2);
const command = args[0];
const rest = args.slice(1);

function runTauri(commandArgs) {
  const result = spawnSync(tauriBin, commandArgs, {
    cwd: rootDir,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  return result.status ?? 1;
}

function hostPlatformName() {
  switch (process.platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    default:
      return "Linux";
  }
}

function buildPlans(extraArgs) {
  return [
    {
      label: "Windows",
      supported: process.platform === "win32",
      reason: "기본 설정에서는 Windows 호스트에서만 안정적으로 빌드합니다.",
      args: ["build", ...extraArgs],
    },
    {
      label: "macOS",
      supported: process.platform === "darwin",
      reason: "기본 설정에서는 macOS 호스트에서만 안정적으로 빌드합니다.",
      args: ["build", ...extraArgs],
    },
    {
      label: "Linux",
      supported: process.platform === "linux",
      reason: "기본 설정에서는 Linux 호스트에서만 안정적으로 빌드합니다.",
      args: ["build", ...extraArgs],
    },
  ];
}

if (command !== "build") {
  process.exit(runTauri(args));
}

const plans = buildPlans(rest);
const failures = [];

console.log(`[tauri-build] Host: ${hostPlatformName()}`);
for (const plan of plans) {
  if (!plan.supported) {
    console.log(`[tauri-build] ${plan.label} 빌드는 건너뜁니다. ${plan.reason}`);
    continue;
  }
  console.log(`[tauri-build] ${plan.label} 빌드를 시작합니다.`);
  const status = runTauri(plan.args);
  if (status !== 0) {
    failures.push(plan.label);
    console.error(`[tauri-build] ${plan.label} 빌드가 실패했습니다. 다음 빌드를 계속 진행합니다.`);
  } else {
    console.log(`[tauri-build] ${plan.label} 빌드가 완료되었습니다.`);
  }
}

if (failures.length > 0) {
  console.error(`[tauri-build] 실패한 빌드: ${failures.join(", ")}`);
  process.exit(1);
}

