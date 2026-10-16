import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
for (const name of ['hik-sdk-download-worker-test.py', 'stage-hik-sdk-test.py']) {
  test(`Linux SDK Python contract: ${name}`, { skip: process.platform !== 'linux' }, () => {
    execFileSync('python3', [fileURLToPath(new URL(name, import.meta.url))], {
      timeout: 30000, stdio: 'pipe', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
  });
}
