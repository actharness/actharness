import * as http from 'node:http';
import * as net from 'node:net';
import * as tls from 'node:tls';
import type { NetworkMockCall } from '@actharness/types';
import type { ApiMockEntry, NetworkMockEntry } from './registry.js';
import { matchNetworkEntry, matchApiEntry } from './registry.js';
import { signHostCert } from './ca-cert.js';
import type { CaBundle } from './ca-cert.js';

export interface ProxyHit {
  entryHandle: import('./registry.js').NetworkMockHandle;
  call: NetworkMockCall;
}

export class ProxyMockServer {
  private _server: http.Server;
  private _apiEntries: ApiMockEntry[] = [];
  private _networkEntries: NetworkMockEntry[] = [];
  private _hits: ProxyHit[] = [];
  private _ca: CaBundle;
  port = 0;

  constructor(ca: CaBundle) {
    this._ca = ca;
    this._server = http.createServer((req, res) => {
      this._handleHttp(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(502);
          res.end(`[actharness] proxy error: ${(err as Error).message}`);
        }
      });
    });

    this._server.on('connect', (req, socket, head) => {
      this._handleConnect(req, socket as net.Socket, head).catch((err) => {
        socket.end(`HTTP/1.1 502 Proxy error\r\n\r\n${(err as Error).message}`);
      });
    });
  }

  loadMocks(apiEntries: ApiMockEntry[], networkEntries: NetworkMockEntry[]): void {
    this._apiEntries = apiEntries;
    this._networkEntries = networkEntries;
    this._hits = [];
  }

  clearMocks(): void {
    this._apiEntries = [];
    this._networkEntries = [];
  }

  getHits(): ProxyHit[] {
    return this._hits;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this._server.listen(0, '127.0.0.1', () => {
        const addr = this._server.address() as net.AddressInfo;
        this.port = addr.port;
        resolve();
      });
      this._server.once('error', reject);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this._server.close((err) => err ? reject(err) : resolve());
    });
  }

  // ── HTTP plain request ────────────────────────────────────────────────────

  private async _handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url!;
    const method = req.method!.toUpperCase();
    const requestHeaders = headersToRecord(req.headers);
    const requestBody = await readBody(req);

    const { status, body, responseHeaders, matchedPattern, entryHandle, rawBody } =
      await this._match(url, method, requestHeaders, requestBody);

    if (entryHandle) {
      this._hits.push({
        entryHandle,
        call: { url, method, requestHeaders, requestBody, response: rawBody, matchedPattern },
      });
    }

    res.writeHead(status, responseHeaders);
    res.end(body);
  }

  // ── HTTPS CONNECT tunnel ──────────────────────────────────────────────────

  private async _handleConnect(req: http.IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    const hostHeader = req.url!;
    const colonIdx = hostHeader.lastIndexOf(':');
    const hostname = colonIdx !== -1 ? hostHeader.slice(0, colonIdx) : hostHeader;

    socket.write('HTTP/1.1 200 Connection established\r\n\r\n');

    const hostCert = await signHostCert(hostname, this._ca);

    const tlsSocket = new tls.TLSSocket(socket, {
      isServer: true,
      key: hostCert.keyPem,
      cert: hostCert.certPem,
    });

    if (head.length > 0) tlsSocket.unshift(head);

    await this._serveInnerHttp(hostname, tlsSocket);
  }

  private _serveInnerHttp(hostname: string, socket: tls.TLSSocket): Promise<void> {
    return new Promise((resolve) => {
      const innerServer = http.createServer();

      innerServer.on('request', async (req, res) => {
        const path = req.url!;
        const url = `https://${hostname}${path}`;
        const method = req.method!.toUpperCase();
        const requestHeaders = headersToRecord(req.headers);
        const requestBody = await readBody(req);

        const { status, body, responseHeaders, matchedPattern, entryHandle, rawBody } =
          await this._match(url, method, requestHeaders, requestBody);

        if (entryHandle) {
          this._hits.push({
            entryHandle,
            call: { url, method, requestHeaders, requestBody, response: rawBody, matchedPattern },
          });
        }

        res.writeHead(status, responseHeaders);
        res.end(body);
      });

      innerServer.emit('connection', socket);

      socket.once('close', () => {
        innerServer.close();
        resolve();
      });
      socket.once('error', () => {
        innerServer.close();
        resolve();
      });
    });
  }

  // ── Matcher engine ────────────────────────────────────────────────────────

  private async _match(
    url: string,
    method: string,
    requestHeaders: Record<string, string>,
    requestBody: string | null,
  ): Promise<{
    status: number;
    body: string;
    responseHeaders: Record<string, string>;
    matchedPattern: string;
    entryHandle: import('./registry.js').NetworkMockHandle | null;
    rawBody: unknown;
  }> {
    // Try GitHub API routes first
    const apiEntry = matchApiEntry(this._apiEntries, url, method);
    if (apiEntry) {
      if (apiEntry.once) apiEntry.consumed = true;
      const rawBody = apiEntry.response;
      return {
        status: 200,
        body: JSON.stringify(rawBody),
        responseHeaders: { 'content-type': 'application/json' },
        matchedPattern: apiEntry.pattern,
        entryHandle: apiEntry.handle,
        rawBody,
      };
    }

    // Try network mocks
    const netEntry = matchNetworkEntry(this._networkEntries, url, method);
    if (netEntry) {
      if (netEntry.once) netEntry.consumed = true;
      let rawBody: unknown;
      let status = netEntry.status;
      let extraHeaders: Record<string, string> | undefined;

      if (netEntry.responseFactory) {
        const result = netEntry.responseFactory(url, method, requestBody);
        rawBody = result.body;
        if (result.status !== undefined) status = result.status;
        extraHeaders = result.headers;
      } else {
        rawBody = netEntry.response;
        extraHeaders = netEntry.responseHeaders;
      }

      const responseHeaders: Record<string, string> = {};
      let body: string;
      if (typeof rawBody === 'string') {
        body = rawBody;
      } else {
        body = JSON.stringify(rawBody);
        responseHeaders['content-type'] = 'application/json';
      }
      if (extraHeaders) Object.assign(responseHeaders, extraHeaders);

      return {
        status,
        body,
        responseHeaders,
        matchedPattern: String(netEntry.matcher),
        entryHandle: netEntry.handle,
        rawBody,
      };
    }

    return {
      status: 502,
      body: JSON.stringify({ error: `[actharness] no mock registered for ${method} ${url}` }),
      responseHeaders: { 'content-type': 'application/json' },
      matchedPattern: '',
      entryHandle: null,
      rawBody: undefined,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function headersToRecord(headers: http.IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) {
      result[k] = Array.isArray(v) ? v.join(', ') : v;
    }
  }
  return result;
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      resolve(body.length > 0 ? body : null);
    });
    req.on('error', reject);
  });
}
