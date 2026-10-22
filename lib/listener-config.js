/** HTTP deployment controls. Defaults preserve the trusted-LAN development setup. */
export function listenerConfig(env = process.env) {
  const host = env.HIKCLIP_BIND || '0.0.0.0';
  // The in-process MCP client uses IPv4 loopback; both supported binds include it.
  if (!['0.0.0.0', '127.0.0.1'].includes(host)) throw new Error('HIKCLIP_BIND must be 0.0.0.0 or 127.0.0.1');
  const port = env.PORT ? Number(env.PORT) : 30001;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  function flag(name, fallback) {
    if (env[name] === undefined || env[name] === '') return fallback;
    if (!['0', '1'].includes(env[name])) throw new Error(`${name} must be 0 or 1`);
    return env[name] === '1';
  }
  const fallback = flag('HIKCLIP_PORT_FALLBACK', env.NODE_ENV !== 'production');
  return { host, port, attempts: fallback ? Math.min(20, 65535 - port) : 0,
    schedulerEnabled: flag('HIKCLIP_SCHEDULER_ENABLED', true) };
}
