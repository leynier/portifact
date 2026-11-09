import { createServer, type Server } from "node:http";
import { type AddressInfo, connect, type Socket } from "node:net";
import { isStackHost } from "./hosts.ts";
import { TURNSTILE_HOST } from "./turnstile-fake.ts";

// Host mapping that works the same in Chromium, Firefox and WebKit (from spikes/review-cookies):
// every engine accepts an HTTP proxy, and the proxy resolves names itself. CONNECT tunnels for
// the stack's hosts, and Turnstile's, whose script the front end fakes, go to the local HTTPS
// front end; everything else is refused, so no test traffic leaves the machine.
export interface StackProxy {
  url: string;
  close(): Promise<void>;
}

export async function startProxy(httpsPort: number): Promise<StackProxy> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((_req, res) => {
    res.writeHead(403).end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (req, clientSocket: Socket, head: Buffer) => {
    // Node removes the socket's error listener once `connect` fires. Browsers reset tunnels
    // freely (for example their own background requests), so swallow those resets.
    clientSocket.on("error", () => clientSocket.destroy());
    const [host = "", port = ""] = (req.url ?? "").split(":");
    if (!(isStackHost(host) || host === TURNSTILE_HOST) || port !== "443") {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect(httpsPort, "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("close", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
