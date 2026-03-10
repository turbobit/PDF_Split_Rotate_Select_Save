import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const packageJsonPath = join(rootDir, "package.json");
const bundleDir = join(rootDir, "src-tauri", "target", "release", "bundle");

function run(command, options = {}) {
  execSync(command, {
    cwd: rootDir,
    stdio: "inherit",
    shell: true,
    ...options,
  });
}

function runCapture(command) {
  return execSync(command, {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    encoding: "utf8",
  }).trim();
}

function runQuiet(command) {
  try {
    execSync(command, {
      cwd: rootDir,
      stdio: "ignore",
      shell: true,
    });
    return true;
  } catch {
    return false;
  }
}

function collectArtifacts(dirPath, results = []) {
  if (!existsSync(dirPath)) return results;
  for (const entry of readdirSync(dirPath)) {
    const fullPath = join(dirPath, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      collectArtifacts(fullPath, results);
      continue;
    }
    const ext = extname(entry).toLowerCase();
    if (ext === ".sig") continue;
    results.push(fullPath);
  }
  return results;
}

function quotePath(pathValue) {
  return `"${pathValue.replaceAll('"', '\\"')}"`;
}

function quoteArg(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tryRunCapture(command) {
  try {
    return runCapture(command);
  } catch {
    return null;
  }
}

function ensureGhInstalled() {
  const version = tryRunCapture("gh --version");
  if (version) {
    const firstLine = version.split(/\r?\n/)[0]?.trim();
    console.log(`[release] GitHub CLI 확인됨: ${firstLine}`);
    return;
  }

  console.error("[release] GitHub CLI(gh)를 찾지 못했습니다.");
  console.error("[release] npm run release 전에 gh를 설치하고 로그인해야 합니다.");
  console.error("[release] 설치 안내: https://cli.github.com/");
  console.error("[release] macOS 예시: brew install gh");
  console.error("[release] 설치 후 로그인: gh auth login");
  process.exit(1);
}

function ensureTagSynced(tag) {
  console.log(`[release] Syncing git tags...`);
  run("git fetch --tags --force");

  const headCommit = runCapture("git rev-parse HEAD");
  let localTagCommit = tryRunCapture(`git rev-list -n 1 ${tag}`);

  if (!localTagCommit) {
    console.log(`[release] Local tag ${tag} does not exist. Creating it on HEAD (${headCommit.slice(0, 7)})...`);
    run(`git tag ${tag}`);
    localTagCommit = headCommit;
  } else if (localTagCommit !== headCommit) {
    console.log(`[release] Local tag ${tag} points to ${localTagCommit.slice(0, 7)} while HEAD is ${headCommit.slice(0, 7)}.`);
    console.log("[release] Continuing in same-version update mode.");
  }

  const remoteTagLine = tryRunCapture(`git ls-remote --tags origin refs/tags/${tag}`);
  const remoteTagCommit = remoteTagLine ? remoteTagLine.split(/\s+/)[0] : null;

  if (!remoteTagCommit) {
    console.log(`[release] Remote tag ${tag} not found. Pushing tag...`);
    run(`git push origin ${tag}`);
  } else if (remoteTagCommit !== localTagCommit) {
    console.error(`[release] Remote tag ${tag} (${remoteTagCommit.slice(0, 7)}) differs from local (${localTagCommit.slice(0, 7)}).`);
    console.error(`[release] Resolve tag mismatch before running release.`);
    process.exit(1);
  } else {
    console.log(`[release] Tag ${tag} is already synced to origin.`);
  }

  run("git fetch --tags --force");

  return { headCommit, tagCommit: localTagCommit };
}

function getCommitLinesByRange(range) {
  try {
    const output = runCapture(`git log ${range} --pretty=format:%s`);
    if (!output) return [];
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getPreviousTag(currentTag) {
  try {
    const output = runCapture("git tag --sort=version:refname");
    if (!output) return null;
    const tags = output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    const currentIndex = tags.lastIndexOf(currentTag);
    if (currentIndex <= 0) return null;
    return tags[currentIndex - 1];
  } catch {
    return null;
  }
}

function getCommitLines(previousTag, currentTag) {
  try {
    const range = previousTag ? `${previousTag}..HEAD` : "";
    const command = range
      ? `git log ${range} --pretty=format:%s`
      : "git log -n 15 --pretty=format:%s";
    const output = runCapture(command);
    if (!output) return [];
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return previousTag
      ? lines
      : lines.filter((line) => !new RegExp(`^${escapeRegex(currentTag)}\\b`).test(line));
  } catch {
    return [];
  }
}

function buildKoreanReleaseNotes({ tag, compareLine, commits, artifacts }) {
  const date = new Date().toISOString().slice(0, 10);
  const commitSection = commits.length > 0
    ? commits.map((line) => `- ${line}`).join("\n")
    : "- 커밋 메시지 기반 변경 내역을 찾지 못했습니다.";
  const assetSection = artifacts.map((pathValue) => `- ${pathValue.split(/[\\/]/).pop()}`).join("\n");
  return [
    `## ${tag} 릴리스 노트`,
    "",
    "### 요약",
    "- PDF Split Rotate Select Save 데스크톱 앱 배포",
    `- 릴리스 날짜: ${date}`,
    compareLine,
    "",
    "### 주요 변경사항",
    commitSection,
    "",
    "### 포함된 빌드 산출물",
    assetSection,
    "",
    "### 참고",
    "- 실행 환경: Tauri 2 + React + TypeScript",
    "- 모든 PDF 처리 작업은 로컬에서 수행됩니다.",
  ].join("\n");
}

function getReleaseAssetNames(tag) {
  try {
    const json = runCapture(`gh release view ${tag} --json assets`);
    const parsed = JSON.parse(json);
    const assets = Array.isArray(parsed.assets) ? parsed.assets : [];
    return assets
      .map((asset) => asset?.name)
      .filter((name) => typeof name === "string" && name.length > 0);
  } catch {
    return [];
  }
}

function deleteAllReleaseAssets(tag) {
  const assetNames = getReleaseAssetNames(tag);
  if (assetNames.length === 0) return;
  console.log(`[release] Removing ${assetNames.length} existing release asset(s)...`);
  for (const assetName of assetNames) {
    run(`gh release delete-asset ${tag} ${quoteArg(assetName)} --yes`);
  }
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

const version = packageJson.version;
if (!version) {
  console.error("package.json version is missing.");
  process.exit(1);
}

const tag = `v${version}`;
const releaseTitle = `PDF Split Rotate Select Save ${tag} 릴리스`;

ensureGhInstalled();

const { headCommit, tagCommit } = ensureTagSynced(tag);
const sameVersionUpdate = tagCommit && tagCommit !== headCommit;

console.log(`[release] Building desktop bundles for ${tag}...`);
run("npm run tauri build");

const artifacts = collectArtifacts(bundleDir);
if (artifacts.length === 0) {
  console.error(`[release] No build artifacts found in: ${bundleDir}`);
  process.exit(1);
}

console.log(`[release] Found ${artifacts.length} artifact(s).`);
for (const artifact of artifacts) {
  console.log(` - ${artifact}`);
}

console.log(`[release] Checking for existing GitHub release: ${tag}`);
const hasRelease = runQuiet(`gh release view ${tag}`);
const previousTag = getPreviousTag(tag);
const sameVersionBaseTag = previousTag ?? tag;
const compareLine = sameVersionUpdate
  ? previousTag
    ? `- 변경 범위(동일 버전 재릴리스): \`${previousTag}..HEAD\``
    : `- 변경 범위(동일 버전 재릴리스): \`${tag}..HEAD\``
  : previousTag
    ? `- 변경 범위: \`${previousTag} -> ${tag}\``
    : "- 변경 범위: 이전 태그를 찾지 못해 최근 커밋 기준으로 생성";
const commitLines = sameVersionUpdate
  ? getCommitLinesByRange(`${sameVersionBaseTag}..HEAD`)
  : getCommitLines(previousTag, tag);
const notes = buildKoreanReleaseNotes({
  tag,
  compareLine,
  commits: commitLines,
  artifacts,
});

const notesFilePath = join(rootDir, ".release-notes.tmp.md");
writeFileSync(notesFilePath, notes, "utf8");

const artifactArgs = artifacts.map(quotePath).join(" ");
try {
  if (hasRelease) {
    console.log(`[release] Release ${tag} exists. Updating title/notes and uploading assets...`);
    deleteAllReleaseAssets(tag);
    run(`gh release edit ${tag} --title ${quoteArg(releaseTitle)} --notes-file ${quotePath(notesFilePath)}`);
    run(`gh release upload ${tag} ${artifactArgs} --clobber`);
  } else {
    console.log(`[release] Creating release ${tag} and uploading assets...`);
    run(`gh release create ${tag} ${artifactArgs} --title ${quoteArg(releaseTitle)} --notes-file ${quotePath(notesFilePath)}`);
  }
} finally {
  if (existsSync(notesFilePath)) unlinkSync(notesFilePath);
}

console.log(`[release] Done: ${tag}`);
