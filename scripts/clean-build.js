import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const tauriConfig = JSON.parse(readFileSync(join(rootDir, "src-tauri", "tauri.conf.json"), "utf8"));
const productName = tauriConfig.productName || packageJson.name || "app";
const version = packageJson.version || tauriConfig.version || "0.0.0";

if (process.env.TAURI_SKIP_CLEAN_BUILD === "1") {
  console.log("빌드 파일 정리 건너뜀: 현재 플랫폼 빌드에서는 유지합니다.");
  process.exit(0);
}

const releaseBundleDir = join(rootDir, "src-tauri", "target", "release", "bundle");
const debugBundleDir = join(rootDir, "src-tauri", "target", "debug", "bundle");
const releaseDirs = [
  join(rootDir, "src-tauri", "target", "release"),
  join(rootDir, "src-tauri", "target", "x86_64-pc-windows-gnu", "release"),
  join(rootDir, "src-tauri", "target", "linux-x86_64", "release"),
];

function removePath(pathValue, label) {
  if (!existsSync(pathValue)) return;
  rmSync(pathValue, { recursive: true, force: true });
  console.log(`${label} 삭제 완료: ${pathValue}`);
}

function isFinalArtifact(entryName) {
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

function shouldDeleteEntry(entryName) {
  if (entryName === productName || entryName === `${productName}.exe`) return true;
  if (entryName.startsWith(`${productName}-`)) return true;
  if (entryName === "tauri-app" || entryName === "tauri-app.exe") return true;
  if (entryName.startsWith("tauri-app-")) return true;
  if (entryName.includes(version) && isFinalArtifact(entryName)) return true;
  return false;
}

function cleanReleaseArtifacts(dirPath) {
  if (!existsSync(dirPath)) {
    console.log(`릴리스 디렉토리가 존재하지 않습니다. 건너뜁니다: ${dirPath}`);
    return;
  }

  console.log(`릴리스 산출물 정리 중: ${dirPath}`);
  for (const entry of readdirSync(dirPath)) {
    const fullPath = join(dirPath, entry);
    const stats = statSync(fullPath);
    if (!shouldDeleteEntry(entry)) continue;
    if (stats.isDirectory() || stats.isFile()) {
      removePath(fullPath, "릴리스 산출물");
    }
  }
}

console.log("빌드 파일 정리 중...");
removePath(releaseBundleDir, "릴리스 bundle");
removePath(debugBundleDir, "디버그 bundle");
for (const dirPath of releaseDirs) {
  cleanReleaseArtifacts(dirPath);
}
console.log("빌드 파일 정리 완료.");
