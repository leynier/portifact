// Raw HTTP for the load test. Node's fetch rewrites Sec-Fetch-* headers, which the Workers check,
// and cannot reach the local Worker by another URL, so requests go out through node:http(s) with
// keep-alive agents and streamed bodies.
import { Agent as HttpAgent, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

export type Body = Uint8Array | string | Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

export interface Sent {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  ms: number;
}

export interface SendInput {
  method: string;
  /** Where the connection goes. */
  url: string;
  headers?: Record<string, string>;
  body?: Body;
  /** Drop the response body after counting it, for throughput runs. */
  discardBody?: boolean;
  /** Accept a self-signed certificate: only for the local Worker's dev server. */
  selfSigned?: boolean;
}

const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 512 });
const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 512 });
const localAgent = new HttpsAgent({ keepAlive: true, maxSockets: 512, rejectUnauthorized: false });

export function send(input: SendInput): Promise<Sent> {
  const url = new URL(input.url);
  const secure = url.protocol === "https:";
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const outgoing = (secure ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: input.method,
        headers: input.headers,
        agent: secure ? (input.selfSigned ? localAgent : httpsAgent) : httpAgent,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => {
          if (!input.discardBody) chunks.push(chunk);
        });
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks),
            ms: performance.now() - started,
          }),
        );
        incoming.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    const body = input.body;
    if (body === undefined) {
      outgoing.end();
    } else if (typeof body === "string" || body instanceof Uint8Array) {
      outgoing.end(body);
    } else {
      // Streams with backpressure: only a few chunks are in flight at a time.
      Readable.from(body, { objectMode: false }).on("error", reject).pipe(outgoing);
    }
  });
}

export function closeAgents(): void {
  httpAgent.destroy();
  httpsAgent.destroy();
  localAgent.destroy();
}
