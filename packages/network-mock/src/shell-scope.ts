import { drainForProxy, pruneConsumedOnce } from './registry.js';
import { ensureSessionCa } from './ca-cert.js';
import { ProxyMockServer } from './proxy-server.js';
import type { ApiMockEntry, NetworkMockEntry } from './registry.js';

export class ShellNetworkScope {
  private _proxy: ProxyMockServer | null = null;
  private _apiEntries: ApiMockEntry[] = [];
  private _networkEntries: NetworkMockEntry[] = [];
  private _started = false;

  async drainAndStart(): Promise<void> {
    const { apiEntries, networkEntries } = drainForProxy();
    this._apiEntries = apiEntries;
    this._networkEntries = networkEntries;

    if (apiEntries.length === 0 && networkEntries.length === 0) return;

    const ca = await ensureSessionCa();
    this._proxy = new ProxyMockServer(ca);
    this._proxy.loadMocks(apiEntries, networkEntries);
    await this._proxy.start();
    this._started = true;
  }

  isActive(): boolean {
    return this._started && this._proxy !== null;
  }

  getProxyEnv(certPath: string): Record<string, string> {
    if (!this._proxy) return {};
    const proxyUrl = `http://127.0.0.1:${this._proxy.port}`;
    return {
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      SSL_CERT_FILE: certPath,
      CURL_CA_BUNDLE: certPath,
      NODE_EXTRA_CA_CERTS: certPath,
      REQUESTS_CA_BUNDLE: certPath,
    };
  }

  getPwshPrefix(): string {
    return `$PSDefaultParameterValues['*:SkipCertificateCheck'] = $true\n`;
  }

  collectHits(): void {
    if (!this._proxy) return;
    for (const hit of this._proxy.getHits()) {
      hit.entryHandle._record(hit.call);
    }
    this._proxy.clearMocks();
    pruneConsumedOnce();
  }

  async stop(): Promise<void> {
    if (this._proxy) {
      await this._proxy.stop().catch(() => { /* best-effort */ });
      this._proxy = null;
    }
    this._started = false;
  }
}
