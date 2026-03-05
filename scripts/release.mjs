import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

const version = packageJson.version;
if (!version) {
  console.error("package.json version is missing.");
  process.exit(1);
}

const tag = `v${version}`;
const releaseTitle = `PDF Split Rotate Select Save ${tag}`;

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

const artifactArgs = artifacts.map(quotePath).join(" ");
if (hasRelease) {
  console.log(`[release] Release ${tag} exists. Uploading assets with --clobber...`);
  run(`gh release upload ${tag} ${artifactArgs} --clobber`);
} else {
  console.log(`[release] Creating release ${tag} and uploading assets...`);
  run(`gh release create ${tag} ${artifactArgs} --title ${quotePath(releaseTitle)} --generate-notes`);
}

console.log(`[release] Done: ${tag}`);
