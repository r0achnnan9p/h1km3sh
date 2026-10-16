import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const [unit, sha, publicIp] = process.argv.slice(2);
try {
  if (!/^[a-z][a-z0-9-]{0,30}-next\.service$/.test(unit) || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('invalid health arguments');
  const cwd = execFileSync('/usr/bin/systemctl', ['show', unit, '--property=WorkingDirectory', '--value'], { encoding: 'utf8' }).trim();
  if (!fs.realpathSync(cwd).endsWith(`/releases/${sha}`)) throw new Error('release mismatch');
  const status = await fetch('http://127.0.0.1:30001/api/status', { signal: AbortSignal.timeout(2000) });
  const body = await status.json();
  if (status.status !== 200 || body.success !== true || !Array.isArray(body.activeTasks)) throw new Error('invalid task status');
  const mainPid = execFileSync('/usr/bin/systemctl', ['show', unit, '--property=MainPID', '--value'], { encoding: 'utf8' }).trim();
  if (!/^[1-9][0-9]*$/.test(mainPid)) throw new Error('no app PID');
  const identity = await (await fetch('http://127.0.0.1:30001/api/runtime-health', { signal: AbortSignal.timeout(2000) })).json();
  if (typeof identity.preparationOnly !== 'boolean' || identity.recoveryReady !== true) throw new Error('export recovery blocked or invalid runtime profile');
  if (identity.preparationOnly && body.activeTasks.length) throw new Error('preparation instance is not idle');
  if (String(identity.pid) !== mainPid || identity.release !== sha) throw new Error('listener does not belong to expected release/PID');
  // Verify the unauthenticated main listener is not exposed to the LAN.
  const sockets = execFileSync('/usr/bin/ss', ['-H', '-ltn'], { encoding: 'utf8' });
  if (!sockets.split('\n').some(line => /\b127\.0\.0\.1:30001\b/.test(line)) || sockets.split('\n').some(line => /(?:0\.0\.0\.0|\*|\[::\]):30001\b/.test(line))) throw new Error('main listener not loopback-only');
  let protectedGateway = false;
  for (const host of ['127.0.0.1', publicIp]) {
    if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(host || '')) continue;
    try {
      const response = await fetch(`http://${host}:30002/mcp`, { signal: AbortSignal.timeout(2000) });
      if (response.status === 401) protectedGateway = true;
    } catch { /* public bind may be either loopback or the explicitly chosen CT address */ }
  }
  if (!protectedGateway) throw new Error('protected gateway must reject unauthenticated MCP');
} catch (error) {
  console.error(`Native health: ${error.message}`);
  process.exitCode = 1;
}
