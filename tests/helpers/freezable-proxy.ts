/**
 * A TCP proxy that can stop forwarding without closing anything.
 *
 * `freeze()` reproduces a connection that is still open but no longer
 * answers: a frozen database server, or a network path that silently drops
 * packets. Neither side receives an error or a close, which is exactly the
 * situation an unbounded query would wait on.
 */
import net from "node:net";

export type FreezableProxy = {
  port: number;
  /** Stops forwarding in both directions; existing and new connections stay open and silent. */
  freeze(): void;
  /** Closes every connection and the listener. */
  close(): Promise<void>;
};

export async function startFreezableProxy(target: { host: string; port: number }): Promise<FreezableProxy> {
  const sockets = new Set<net.Socket>();
  let frozen = false;

  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => sockets.delete(socket));
    }
    client.on("data", (chunk) => {
      if (!frozen) upstream.write(chunk);
    });
    upstream.on("data", (chunk) => {
      if (!frozen) client.write(chunk);
    });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the proxy did not get a TCP port");

  return {
    port: address.port,
    freeze() {
      frozen = true;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
