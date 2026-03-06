import { existsSync, readdirSync, statSync, unlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const bundleDir = join(rootDir, 'src-tauri', 'target', 'release', 'bundle');
const debugBundleDir = join(rootDir, 'src-tauri', 'target', 'debug', 'bundle');

function deleteBundleFiles(dirPath, label) {
  if (!existsSync(dirPath)) {
    console.log(`${label} 디렉토리가 존재하지 않습니다. 건너뜁니다.`);
    return;
  }

  console.log(`${label} 빌드 파일 정리 중...`);

  try {
    // bundle 폴더 전체를 삭제
    rmSync(dirPath, { recursive: true, force: true });
    console.log(`${label} 폴더 삭제 완료: ${dirPath}`);
  } catch (error) {
    console.error(`${label} 폴더 삭제 실패:`, error.message);
  }
}

deleteBundleFiles(bundleDir, '릴리스');
deleteBundleFiles(debugBundleDir, '디버그');
console.log('빌드 파일 정리 완료.');