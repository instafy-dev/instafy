// Ports and servers for tests, kept apart from every other program on the machine. A server that
// listens on every interface can be given a port another program already holds on 127.0.0.1, and a
// client that dials 127.0.0.1 then reaches that program. A server on [::1] alone, or a port taken
// to be unused, can share its number with another program on the other loopback address, which a
// probe that tries both then finds instead. And a test that gives the CLI no server URL sends it to
// the defaults, where a real controller and Studio may be running.
import { once } from "node:events";
import net from "node:net";

const ATTEMPTS = 20;

/**
 * Whether host:port is taken: true when something accepts a connection, and also when the answer is
 * unclear (an error other than a refusal, or no answer within `timeoutMs`), so a caller looking for
 * a free port moves on to another one.
 */
export function answersOn(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const settle = (taken) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(taken);
    };
    const timer = setTimeout(() => settle(true), timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("error", (error) => settle(error.code !== "ECONNREFUSED"));
  });
}

/** Whether this machine can listen on the IPv6 loopback address. */
export async function ipv6LoopbackAvailable() {
  const server = net.createServer();
  try {
    server.listen(0, "::1");
    await once(server, "listening");
    return true;
  } catch {
    return false;
  } finally {
    server.close();
  }
}

/**
 * A port where nothing answers on 127.0.0.1, nor on [::1] when the machine has it. `avoid` lists
 * ports the caller cannot use, such as the ones `instafy preview` keeps for Instafy.
 */
export async function unusedLoopbackPort({ avoid = [] } = {}) {
  const excluded = new Set(avoid);
  const checkIpv6 = await ipv6LoopbackAvailable();
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    if (excluded.has(port)) continue;
    if (!checkIpv6 || !(await answersOn("::1", port))) return port;
  }
  throw new Error(`No port was unused on both loopback addresses, and outside avoid, after ${ATTEMPTS} tries.`);
}

/**
 * A URL on 127.0.0.1 where nothing listens, for a controller or Studio a test must never reach. A
 * request to it fails at once, so a test that sends one shows it instead of reaching a real service.
 */
export async function unreachableLocalUrl() {
  return `http://127.0.0.1:${await unusedLoopbackPort()}`;
}

/**
 * Starts `server` on [::1] alone, on a port where nothing answers on 127.0.0.1 and that is not in
 * `avoid`, and resolves with the port. Rejects when the machine has no IPv6 loopback, or when no
 * such port turns up.
 */
export async function listenOnIpv6LoopbackOnly(server, { avoid = [] } = {}) {
  const excluded = new Set(avoid);
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    server.listen({ port: 0, host: "::1", ipv6Only: true });
    await once(server, "listening");
    const { port } = server.address();
    if (!excluded.has(port) && !(await answersOn("127.0.0.1", port))) return port;
    await new Promise((resolve) => server.close(resolve));
  }
  throw new Error(`No port was free on both 127.0.0.1 and [::1], and outside avoid, after ${ATTEMPTS} tries.`);
}
