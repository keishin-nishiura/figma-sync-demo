import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 各シナリオスクリプトから、その場でサーバーを1つ起動するためのヘルパー。
export function startServer() {
  const proc = spawn('node', [path.join(__dirname, '..', 'server', 'index.js')], {
    stdio: 'inherit',
  });
  return new Promise((resolve) => {
    setTimeout(() => resolve(proc), 500);
  });
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
