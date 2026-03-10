import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const packageJsonPath = resolve(rootDir, "package.json");
const tauriConfigPath = resolve(rootDir, "src-tauri", "tauri.conf.json");
const linuxDockerImage = "pdf-split-rotate-select-save-tauri-linux-builder:bookworm";
const linuxDockerfile = resolve(rootDir, "scripts", "docker", "linux-builder.Dockerfile");
const linuxDockerTargetDir = "/work/src-tauri/target/linux-x86_64";
const linuxAmd64NodeModulesVolume = "pdf_split_rotate_select_save_linux_amd64_node_modules";
const linuxAmd64CargoRegistryVolume = "pdf_split_rotate_select_save_linux_amd64_cargo_registry";
const linuxAmd64CargoGitVolume = "pdf_split_rotate_select_save_linux_amd64_cargo_git";
const tauriBin = process.platform === "win32"
  ? resolve(rootDir, "node_modules", ".bin", "tauri.cmd")
  : resolve(rootDir, "node_modules", ".bin", "tauri");

const args = process.argv.slice(2);
const command = args[0];
const rest = args.slice(1);
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
const appVersion = packageJson.version || tauriConfig.version || "0.0.0";
const productName = tauriConfig.productName || packageJson.name || "app";
const linuxBuildEnabled = process.env.TAURI_ENABLE_LINUX_BUILD === "1";

function runCommand(commandName, commandArgs, options = {}) {
  return spawnSync(commandName, commandArgs, {
    cwd: rootDir,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
    ...options,
  });
}

function captureCommand(commandName, commandArgs) {
  const result = spawnSync(commandName, commandArgs, {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    env: process.env,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return (result.stdout ?? "").trim();
}

function runTauri(commandArgs, envOverride = process.env) {
  const result = runCommand(tauriBin, commandArgs, { env: envOverride });
  return result.status ?? 1;
}

function commandExists(commandName) {
  const checker = process.platform === "win32" ? "where" : "which";
  return (spawnSync(checker, [commandName], {
    cwd: rootDir,
    stdio: "ignore",
    shell: process.platform === "win32",
  }).status ?? 1) === 0;
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

function formatBool(ok) {
  return ok ? "OK" : "MISSING";
}

function formatMaybe(ok) {
  return ok ? "OK" : "SKIPPED";
}

function supportsColor() {
  return Boolean(process.stdout.isTTY) && process.env.NO_COLOR !== "1";
}

function colorize(text, colorCode) {
  if (!supportsColor()) return text;
  return `\u001b[${colorCode}m${text}\u001b[0m`;
}

function statusBadge(status) {
  switch (status) {
    case "OK":
      return colorize("[OK]", "32;1");
    case "MISSING":
      return colorize("[MISSING]", "31;1");
    case "SKIPPED":
      return colorize("[SKIPPED]", "33;1");
    default:
      return `[${status}]`;
  }
}

function padRight(value, width) {
  const text = String(value);
  return text.length >= width ? text : `${text}${" ".repeat(width - text.length)}`;
}

function printTable(title, rows) {
  const nameWidth = Math.max("항목".length, ...rows.map((row) => row.name.length));
  const statusWidth = Math.max("상태".length, "[MISSING]".length);
  const detailWidth = Math.max("설명".length, ...rows.map((row) => row.detail.length));
  const line = `+${"-".repeat(nameWidth + 2)}+${"-".repeat(statusWidth + 2)}+${"-".repeat(detailWidth + 2)}+`;

  console.log(`[tauri-build][doctor] ${title}`);
  console.log(`[tauri-build][doctor] ${line}`);
  console.log(`[tauri-build][doctor] | ${padRight("항목", nameWidth)} | ${padRight("상태", statusWidth)} | ${padRight("설명", detailWidth)} |`);
  console.log(`[tauri-build][doctor] ${line}`);
  for (const row of rows) {
    console.log(`[tauri-build][doctor] | ${padRight(row.name, nameWidth)} | ${padRight(statusBadge(row.status), statusWidth)} | ${padRight(row.detail, detailWidth)} |`);
  }
  console.log(`[tauri-build][doctor] ${line}`);
}

function getArgValue(extraArgs, longName, shortName) {
  const longIndex = extraArgs.findIndex((arg) => arg === longName);
  if (longIndex >= 0) return extraArgs[longIndex + 1] ?? null;
  const shortIndex = extraArgs.findIndex((arg) => arg === shortName);
  if (shortIndex >= 0) return extraArgs[shortIndex + 1] ?? null;
  return null;
}

function hasArg(extraArgs, ...names) {
  return extraArgs.some((arg) => names.includes(arg));
}

function hasExplicitTarget(extraArgs) {
  return extraArgs.some((arg, index) => arg === "--target" || arg === "-t" || (index > 0 && (extraArgs[index - 1] === "--target" || extraArgs[index - 1] === "-t")));
}

function shouldInjectCrossRunner(targetTriple) {
  if (!targetTriple) return false;
  if (process.platform === "win32" && targetTriple.includes("windows")) return false;
  if (process.platform === "linux" && targetTriple.includes("linux")) return false;
  if (process.platform === "darwin" && targetTriple.includes("apple-darwin")) return false;
  return targetTriple === "x86_64-pc-windows-gnu" || targetTriple === "x86_64-unknown-linux-gnu";
}

function getInstalledRustTargets() {
  const output = captureCommand("rustup", ["target", "list", "--installed"]);
  return new Set((output ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean));
}

function crossBuildReadiness(targetTriple, installedTargets) {
  if (!installedTargets.has(targetTriple)) {
    return {
      ok: false,
      reason: `rustup target add ${targetTriple} 가 필요합니다.`,
    };
  }
  if (!commandExists("cargo-zigbuild")) {
    return {
      ok: false,
      reason: "cargo-zigbuild 가 설치되어 있지 않습니다. cargo install cargo-zigbuild 가 필요합니다.",
    };
  }
  if (!commandExists("zig")) {
    return {
      ok: false,
      reason: "zig 가 설치되어 있지 않습니다. zig 설치가 필요합니다.",
    };
  }
  return { ok: true, reason: "" };
}

function windowsCrossEnv() {
  const mingwRoot = "/opt/homebrew/opt/mingw-w64/toolchain-x86_64";
  const sysrootFlag = `--sysroot=${mingwRoot}`;
  return {
    ...process.env,
    CC_x86_64_pc_windows_gnu: "/opt/homebrew/bin/x86_64-w64-mingw32-gcc",
    CXX_x86_64_pc_windows_gnu: "/opt/homebrew/bin/x86_64-w64-mingw32-g++",
    AR_x86_64_pc_windows_gnu: "/opt/homebrew/bin/x86_64-w64-mingw32-ar",
    CFLAGS_x86_64_pc_windows_gnu: `${sysrootFlag} -Wno-error=date-time`,
    CXXFLAGS_x86_64_pc_windows_gnu: `${sysrootFlag} -Wno-error=date-time`,
  };
}

function windowsCrossReady(installedTargets) {
  const base = crossBuildReadiness("x86_64-pc-windows-gnu", installedTargets);
  if (!base.ok) return base;
  if (!commandExists("x86_64-w64-mingw32-gcc") || !commandExists("x86_64-w64-mingw32-dlltool")) {
    return {
      ok: false,
      reason: "mingw-w64 가 설치되어 있지 않습니다. brew install mingw-w64 가 필요합니다.",
    };
  }
  return { ok: true, reason: "" };
}

function linuxCrossReady(installedTargets) {
  if (!commandExists("docker")) {
    return {
      ok: false,
      reason: "docker 가 없습니다. brew install docker colima 후 colima start 가 필요합니다.",
    };
  }
  const dockerInfo = spawnSync("docker", ["info"], {
    cwd: rootDir,
    stdio: ["ignore", "ignore", "ignore"],
    shell: process.platform === "win32",
    env: process.env,
  });
  if ((dockerInfo.status ?? 1) !== 0) {
    return {
      ok: false,
      reason: "docker daemon 이 준비되지 않았습니다. colima start 또는 Docker Desktop 실행이 필요합니다.",
    };
  }
  if (!commandExists("docker-buildx") && !captureCommand("docker", ["buildx", "version"])) {
    return {
      ok: false,
      reason: "docker buildx 가 없습니다. brew install docker-buildx 설정이 필요합니다.",
    };
  }
  return { ok: true, reason: "" };
}

function buildPlans(extraArgs, installedTargets) {
  const windowsReady = windowsCrossReady(installedTargets);
  const linuxReady = linuxCrossReady(installedTargets);
  const linuxSupported = process.platform === "linux"
    ? linuxBuildEnabled
    : linuxBuildEnabled && linuxReady.ok;
  const linuxReason = linuxBuildEnabled
    ? (process.platform === "linux" ? "" : linuxReady.reason)
    : "Linux 빌드는 현재 기본값으로 비활성화되어 있습니다. TAURI_ENABLE_LINUX_BUILD=1 로 다시 켤 수 있습니다.";
  return [
    {
      label: "Windows",
      targetTriple: process.platform === "win32" ? null : "x86_64-pc-windows-gnu",
      supported: process.platform === "win32" || windowsReady.ok,
      reason: process.platform === "win32" ? "" : windowsReady.reason,
      args: process.platform === "win32"
        ? ["build", ...extraArgs]
        : ["build", "--target", "x86_64-pc-windows-gnu", "--no-bundle", ...extraArgs],
      mode: process.platform === "win32" ? "native bundle" : "cross binary",
      canAttempt: process.platform === "win32" || windowsReady.ok,
      env: process.platform === "win32" ? process.env : windowsCrossEnv(),
    },
    {
      label: "macOS",
      targetTriple: null,
      supported: process.platform === "darwin",
      reason: "macOS 앱 번들은 Apple SDK와 서명 체인 때문에 macOS 호스트에서만 안정적으로 빌드합니다.",
      args: ["build", ...extraArgs],
      mode: "native bundle (app+dmg)",
      canAttempt: process.platform === "darwin",
      env: process.env,
    },
    {
      label: "Linux",
      targetTriple: process.platform === "linux" ? null : "linux/amd64",
      supported: linuxSupported,
      reason: linuxReason,
      args: process.platform === "linux"
        ? ["build", ...extraArgs]
        : ["build", ...extraArgs],
      mode: process.platform === "linux" ? "native bundle" : "docker native bundle",
      canAttempt: linuxSupported,
      env: process.env,
      runner: process.platform === "linux" ? "tauri" : "docker-linux",
      artifactRoot: process.platform === "linux"
        ? join(rootDir, "src-tauri", "target", "release")
        : join(rootDir, "src-tauri", "target", "linux-x86_64", "release"),
    },
  ];
}

function buildDoctor(plans, installedTargets) {
  const hasRustup = commandExists("rustup");
  const hasCargoZigbuild = commandExists("cargo-zigbuild");
  const hasZig = commandExists("zig");
  const hasMingwGcc = commandExists("x86_64-w64-mingw32-gcc");
  const hasMingwDlltool = commandExists("x86_64-w64-mingw32-dlltool");
  const hasDocker = commandExists("docker");
  const hasColima = commandExists("colima");
  const hasDockerBuildx = Boolean(commandExists("docker-buildx") || captureCommand("docker", ["buildx", "version"]));
  const dockerDaemonReady = hasDocker && (spawnSync("docker", ["info"], {
    cwd: rootDir,
    stdio: ["ignore", "ignore", "ignore"],
    shell: process.platform === "win32",
    env: process.env,
  }).status ?? 1) === 0;
  const coreRows = [
    { name: "Host", status: "OK", detail: hostPlatformName() },
    { name: "rustup", status: formatBool(hasRustup), detail: "Rust 타깃 설치 관리" },
    { name: "cargo-zigbuild", status: formatBool(hasCargoZigbuild), detail: "Windows cross build runner" },
    { name: "zig", status: formatBool(hasZig), detail: "크로스 링크 보조 도구" },
  ];
  const platformRows = [
    { name: "macOS Xcode CLI", status: formatBool(commandExists("xcrun")), detail: "macOS native bundle toolchain" },
    { name: "Windows mingw gcc", status: formatBool(hasMingwGcc), detail: "x86_64-w64-mingw32-gcc" },
    { name: "Windows mingw dlltool", status: formatBool(hasMingwDlltool), detail: "x86_64-w64-mingw32-dlltool" },
    { name: "Linux docker", status: linuxBuildEnabled ? formatBool(hasDocker) : "SKIPPED", detail: linuxBuildEnabled ? "컨테이너 빌드 런타임" : "Linux 빌드 비활성화 상태" },
    { name: "Linux colima", status: linuxBuildEnabled ? formatMaybe(hasColima) : "SKIPPED", detail: linuxBuildEnabled ? "macOS용 Docker daemon 런타임" : "Linux 빌드 비활성화 상태" },
    { name: "Linux docker buildx", status: linuxBuildEnabled ? formatBool(hasDockerBuildx) : "SKIPPED", detail: linuxBuildEnabled ? "linux/amd64 builder image 생성" : "Linux 빌드 비활성화 상태" },
    { name: "Linux docker daemon", status: linuxBuildEnabled ? formatBool(dockerDaemonReady) : "SKIPPED", detail: linuxBuildEnabled ? "docker info 응답 여부" : "Linux 빌드 비활성화 상태" },
  ];
  const targetRows = plans
    .filter((plan) => plan.targetTriple)
    .map((plan) => {
      const ready = plan.targetTriple === "linux/amd64"
        ? (linuxBuildEnabled ? dockerDaemonReady && hasDockerBuildx : false)
        : installedTargets.has(plan.targetTriple);
      return {
        name: `${plan.label} target`,
        status: plan.targetTriple === "linux/amd64" && !linuxBuildEnabled ? "SKIPPED" : formatBool(ready),
        detail: plan.targetTriple,
      };
    });
  const summaryRows = plans.map((plan) => ({
    name: plan.label,
    status: plan.label === "Linux" && !linuxBuildEnabled ? "SKIPPED" : (plan.canAttempt ? "OK" : "MISSING"),
    detail: plan.canAttempt ? `빌드 가능 (${plan.mode})` : `${plan.label === "Linux" && !linuxBuildEnabled ? "빌드 비활성화" : "빌드 불가"}: ${plan.reason}`,
  }));

  console.log("[tauri-build][doctor] 사전 점검");
  printTable("공통 도구", coreRows);
  printTable("플랫폼 툴체인", platformRows);
  printTable("타깃 준비 상태", targetRows);
  printTable("플랫폼별 빌드 가능 여부", summaryRows);
  for (const row of summaryRows) {
    console.log(`[tauri-build][doctor] ${row.name}: ${row.detail}`);
  }

  if (process.platform === "darwin") {
    const missingTargets = plans
      .filter((plan) => plan.targetTriple && !plan.targetTriple.startsWith("linux/") && !installedTargets.has(plan.targetTriple))
      .map((plan) => plan.targetTriple);
    if (
      missingTargets.length > 0
      || !hasZig
      || !hasCargoZigbuild
      || !hasMingwGcc
      || !hasMingwDlltool
      || (linuxBuildEnabled && !hasDocker)
      || (linuxBuildEnabled && !dockerDaemonReady)
      || (linuxBuildEnabled && !hasColima)
      || (linuxBuildEnabled && !hasDockerBuildx)
    ) {
      console.log("[tauri-build][doctor] macOS 크로스 빌드 준비 안내:");
      for (const target of missingTargets) {
        console.log(`[tauri-build][doctor]   rustup target add ${target}`);
      }
      if (!hasCargoZigbuild) {
        console.log("[tauri-build][doctor]   cargo install cargo-zigbuild");
      }
      if (!hasZig) {
        console.log("[tauri-build][doctor]   brew install zig");
      }
      if (!hasMingwGcc || !hasMingwDlltool) {
        console.log("[tauri-build][doctor]   brew install mingw-w64");
      }
      if (linuxBuildEnabled && (!hasDocker || !hasColima)) {
        console.log("[tauri-build][doctor]   brew install docker colima");
      }
      if (linuxBuildEnabled && !hasDockerBuildx) {
        console.log("[tauri-build][doctor]   brew install docker-buildx");
        console.log("[tauri-build][doctor]   ~/.docker/config.json 에 cliPluginsExtraDirs 추가");
      }
      if (linuxBuildEnabled && !dockerDaemonReady) {
        console.log("[tauri-build][doctor]   colima start");
      }
    }
  }
}

function collectFiles(dirPath, results = []) {
  if (!existsSync(dirPath)) return results;
  for (const entry of readdirSync(dirPath)) {
    const fullPath = join(dirPath, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      collectFiles(fullPath, results);
      continue;
    }
    results.push(fullPath);
  }
  return results;
}

function relativeTargetPath(pathValue) {
  return pathValue.startsWith(`${rootDir}/`) ? pathValue.slice(rootDir.length + 1) : pathValue;
}

function isFinalArtifactName(entryName) {
  return [
    ".app",
    ".dmg",
    ".pkg",
    ".msi",
    ".exe",
    ".deb",
    ".rpm",
    ".AppImage",
    ".zip",
    ".tar.gz",
  ].some((suffix) => entryName.endsWith(suffix));
}

function splitArtifactName(entryName) {
  if (entryName.endsWith(".tar.gz")) {
    return {
      stem: entryName.slice(0, -".tar.gz".length),
      ext: ".tar.gz",
    };
  }
  const ext = extname(entryName);
  return {
    stem: ext ? entryName.slice(0, -ext.length) : entryName,
    ext,
  };
}

function normalizeArtifactName(entryName, version) {
  const { stem, ext } = splitArtifactName(entryName);
  const preferredStem = `${productName}-${version}`;
  const stripLeadingVersion = (value) => value
    .replace(new RegExp(`^[-_]?${version}`), "")
    .replace(/^[-_]+/, (match) => match[0] ?? "");
  if (stem === preferredStem || stem.startsWith(`${preferredStem}-`) || stem.startsWith(`${preferredStem}_`)) {
    return entryName;
  }

  const knownPrefixes = [productName, packageJson.name, "tauri-app"];
  for (const prefix of knownPrefixes) {
    if (stem === prefix) return `${preferredStem}${ext}`;
    if (stem.startsWith(`${prefix}-`) || stem.startsWith(`${prefix}_`)) {
      const tail = stripLeadingVersion(stem.slice(prefix.length));
      return `${preferredStem}${tail}${ext}`;
    }
  }

  const versionIndex = stem.indexOf(version);
  if (versionIndex >= 0) {
    const tail = stem.slice(versionIndex + version.length);
    return `${preferredStem}${tail}${ext}`;
  }

  const separatorIndex = stem.search(/[-_]/);
  if (separatorIndex > 0) {
    return `${preferredStem}${stem.slice(separatorIndex)}${ext}`;
  }

  return `${preferredStem}${ext}`;
}

function collectRenamableArtifacts(dirPath, results = []) {
  if (!existsSync(dirPath)) return results;
  for (const entry of readdirSync(dirPath)) {
    const fullPath = join(dirPath, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      if (isFinalArtifactName(entry)) {
        results.push(fullPath);
        continue;
      }
      collectRenamableArtifacts(fullPath, results);
      continue;
    }
    if (isFinalArtifactName(entry)) {
      results.push(fullPath);
    }
  }
  return results;
}

function renameArtifactIfNeeded(pathValue, version) {
  const currentName = basename(pathValue);
  const nextName = normalizeArtifactName(currentName, version);
  if (currentName === nextName) return pathValue;
  const nextPath = join(dirname(pathValue), nextName);
  if (existsSync(nextPath)) {
    rmSync(nextPath, { recursive: true, force: true });
  }
  renameSync(pathValue, nextPath);
  return nextPath;
}

function renameBundleArtifacts(plan, version) {
  const releaseDir = plan.artifactRoot ?? (
    plan.targetTriple
      ? join(rootDir, "src-tauri", "target", plan.targetTriple, "release")
      : join(rootDir, "src-tauri", "target", "release")
  );
  const bundleDir = join(releaseDir, "bundle");
  const renamed = [];

  for (const artifactPath of collectRenamableArtifacts(bundleDir)) {
    renamed.push(renameArtifactIfNeeded(artifactPath, version));
  }

  const releaseEntries = existsSync(releaseDir) ? readdirSync(releaseDir) : [];
  for (const entry of releaseEntries) {
    const fullPath = join(releaseDir, entry);
    const stats = statSync(fullPath);
    if (!stats.isFile()) continue;
    if ([".dll", ".dylib", ".so", ".a"].includes(extname(entry))) continue;
    if (
      entry === productName
      || entry === `${productName}.exe`
      || entry === packageJson.name
      || entry === `${packageJson.name}.exe`
      || entry === "tauri-app"
      || entry === "tauri-app.exe"
    ) {
      renamed.push(renameArtifactIfNeeded(fullPath, version));
    }
  }

  return renamed;
}

function summarizeArtifacts(plan) {
  const releaseDir = plan.artifactRoot ?? (
    plan.targetTriple
      ? join(rootDir, "src-tauri", "target", plan.targetTriple, "release")
      : join(rootDir, "src-tauri", "target", "release")
  );
  const bundleDir = join(releaseDir, "bundle");

  const binaryArtifacts = collectFiles(releaseDir)
    .filter((filePath) => !filePath.includes("/.fingerprint/"))
    .filter((filePath) => !filePath.includes("/build/"))
    .filter((filePath) => !filePath.endsWith(".d"))
    .filter((filePath) => !filePath.endsWith(".o"))
    .filter((filePath) => !filePath.endsWith(".rlib"))
    .filter((filePath) => !filePath.endsWith(".rmeta"))
    .filter((filePath) => !filePath.endsWith(".dSYM"))
    .filter((filePath) => !filePath.includes("/deps/"))
    .filter((filePath) => !filePath.includes("/incremental/"))
    .filter((filePath) => !filePath.includes("/examples/"))
    .filter((filePath) => !filePath.includes("/bundle/"));

  const bundleArtifacts = collectFiles(bundleDir)
    .filter((filePath) => !filePath.endsWith(".sig"));

  const selected = [...bundleArtifacts, ...binaryArtifacts]
    .map(relativeTargetPath)
    .filter((value, index, array) => array.indexOf(value) === index)
    .slice(0, 8);

  return selected;
}

function ensureLinuxDockerImage() {
  const inspect = captureCommand("docker", ["image", "inspect", linuxDockerImage, "--format", "{{.Architecture}}"]);
  if (inspect === "amd64") return 0;

  if (inspect && inspect !== "amd64") {
    console.log(`[tauri-build] Linux builder image 아키텍처를 amd64 로 다시 생성합니다. 현재: ${inspect}`);
  } else {
    console.log(`[tauri-build] Linux builder image 생성: ${linuxDockerImage}`);
  }

  const build = runCommand("docker", [
    "buildx",
    "build",
    "--platform",
    "linux/amd64",
    "--load",
    "-t",
    linuxDockerImage,
    "-f",
    linuxDockerfile,
    ".",
  ]);
  return build.status ?? 1;
}

function dockerVolume(name) {
  return `${name}:/` + name.split("_").slice(2).join("_");
}

function runLinuxDockerBuild(extraArgs, envOverride = process.env) {
  const imageStatus = ensureLinuxDockerImage();
  if (imageStatus !== 0) return imageStatus;

  const linuxArgs = ["build", ...extraArgs];
  const tauriCommand = [
    "set -euo pipefail",
    "npm ci",
    `CARGO_TARGET_DIR=${linuxDockerTargetDir} ./node_modules/.bin/tauri ${linuxArgs.join(" ")}`,
  ].join(" && ");

  const dockerArgs = [
    "run",
    "--rm",
    "--platform",
    "linux/amd64",
    "-e",
    `TAURI_SKIP_CLEAN_BUILD=${envOverride.TAURI_SKIP_CLEAN_BUILD ?? ""}`,
    "-v",
    `${rootDir}:/work`,
    "-v",
    `${linuxAmd64NodeModulesVolume}:/work/node_modules`,
    "-v",
    `${linuxAmd64CargoRegistryVolume}:/root/.cargo/registry`,
    "-v",
    `${linuxAmd64CargoGitVolume}:/root/.cargo/git`,
    "-w",
    "/work",
    linuxDockerImage,
    "bash",
    "-lc",
    tauriCommand,
  ];
  return runCommand("docker", dockerArgs).status ?? 1;
}

function printArtifactSummary(results) {
  console.log("[tauri-build] 산출물 요약");
  for (const result of results) {
    if (result.status === "skipped") {
      console.log(`[tauri-build] ${result.label}: skipped`);
      continue;
    }
    if (result.status === "failed") {
      console.log(`[tauri-build] ${result.label}: failed`);
      continue;
    }
    if (result.artifacts.length === 0) {
      console.log(`[tauri-build] ${result.label}: 완료됐지만 찾은 산출물이 없습니다.`);
      continue;
    }
    console.log(`[tauri-build] ${result.label}:`);
    for (const artifact of result.artifacts) {
      console.log(`[tauri-build]   - ${artifact}`);
    }
  }
}

if (command !== "build") {
  process.exit(runTauri(args));
}

if (hasExplicitTarget(rest)) {
  const explicitTarget = getArgValue(rest, "--target", "-t");
  const explicitRunner = getArgValue(rest, "--runner", "-r");
  if (shouldInjectCrossRunner(explicitTarget) && !explicitRunner) {
    const patchedArgs = [...rest, "--runner", "cargo-zigbuild"];
    if (!hasArg(rest, "--no-bundle")) {
      patchedArgs.push("--no-bundle");
    }
    console.log(`[tauri-build] ${explicitTarget} 크로스 빌드에는 cargo-zigbuild 를 자동 적용합니다.`);
    const envOverride = explicitTarget === "x86_64-pc-windows-gnu" ? windowsCrossEnv() : process.env;
    process.exit(runTauri(["build", ...patchedArgs], envOverride));
  }
  console.log("[tauri-build] --target 이 명시되어 있으므로 멀티 플랫폼 래퍼를 우회하고 원본 tauri build 를 실행합니다.");
  process.exit(runTauri(["build", ...rest]));
}

const installedTargets = getInstalledRustTargets();
const plans = buildPlans(rest, installedTargets);
const failures = [];
const results = [];
let cleanedOnce = false;

buildDoctor(plans, installedTargets);
console.log(`[tauri-build] Host: ${hostPlatformName()}`);
for (const plan of plans) {
  if (!plan.canAttempt) {
    console.log(`[tauri-build] ${plan.label} 빌드는 건너뜁니다. ${plan.reason}`);
    results.push({ label: plan.label, status: "skipped", artifacts: [] });
    continue;
  }

  const targetText = plan.targetTriple ? ` (${plan.targetTriple})` : "";
  console.log(`[tauri-build] ${plan.label}${targetText} 빌드를 시작합니다. 모드: ${plan.mode}`);
  const envForRun = cleanedOnce
    ? { ...plan.env, TAURI_SKIP_CLEAN_BUILD: "1" }
    : plan.env;
  const status = plan.runner === "docker-linux"
    ? runLinuxDockerBuild(rest, envForRun)
    : runTauri(plan.args, envForRun);
  if (status !== 0) {
    failures.push(plan.label);
    results.push({ label: plan.label, status: "failed", artifacts: [] });
    console.error(`[tauri-build] ${plan.label} 빌드가 실패했습니다. 다음 빌드를 계속 진행합니다.`);
  } else {
    cleanedOnce = true;
    renameBundleArtifacts(plan, appVersion);
    results.push({ label: plan.label, status: "ok", artifacts: summarizeArtifacts(plan) });
    console.log(`[tauri-build] ${plan.label} 빌드가 완료되었습니다.`);
  }
}

printArtifactSummary(results);

if (failures.length > 0) {
  console.error(`[tauri-build] 실패한 빌드: ${failures.join(", ")}`);
  process.exit(1);
}
