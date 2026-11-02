// Port selection for the one-click launcher: start at a preferred port and
// walk upward until one is free, so a busy port never blocks a non-technical user.

import net from 'node:net';

export const MAX_PORT = 65535;

/** Ports to try, in order: start, start+1, ... (never past 65535). Pure. */
export function candidatePorts(start, maxTries = 50) {
  const first = Number(start);
  if (!Number.isInteger(first) || first < 1 || first > MAX_PORT) throw new RangeError(`invalid start port: ${start}`);
  const out = [];
  for (let p = first; p <= MAX_PORT && out.length < maxTries; p++) out.push(p);
  return out;
}

/** Resolve true if nothing is listening on host:port (probe by binding briefly). */
export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

/**
 * First free port at or above `start`.
 * @param {number} start
 * @param {{ host?: string, maxTries?: number, isFree?: (port:number, host:string) => Promise<boolean> }} [opts]
 */
export async function findFreePort(start, { host = '127.0.0.1', maxTries = 50, isFree = isPortFree } = {}) {
  for (const port of candidatePorts(start, maxTries)) {
    if (await isFree(port, host)) return port;
  }
  throw new Error(`no free port in ${start}..${start + maxTries - 1}`);
}

/**
 * Listen on the first port >= start that actually binds. Retries on EADDRINUSE,
 * which closes the race between probing and binding.
 * @param {{ listen(port:number): Promise<string> }} app  object returned by createOverlayServer
 * @returns {Promise<{ url: string, port: number }>}
 */
export async function listenOnFreePort(app, start, { host = '127.0.0.1', maxTries = 50, isFree = isPortFree } = {}) {
  if (start === 0) {
    // Port 0 = let the OS pick any free port (tests, scripts).
    const url = await app.listen(0);
    return { url, port: Number(new URL(url).port) };
  }
  let from = start;
  const last = Math.min(MAX_PORT, start + maxTries - 1);
  while (from <= last) {
    const port = await findFreePort(from, { host, maxTries: last - from + 1, isFree });
    try {
      const url = await app.listen(port);
      return { url, port };
    } catch (err) {
      if (err?.code !== 'EADDRINUSE') throw err;
      from = port + 1;
    }
  }
  throw new Error(`no free port in ${start}..${last}`);
}
