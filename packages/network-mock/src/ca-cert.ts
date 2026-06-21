import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import * as x509 from '@peculiar/x509';

export interface CaBundle {
  certPem: string;
  keyPem: string;
  certPath: string;
  keyPath: string;
}

interface HostCert {
  certPem: string;
  keyPem: string;
}

let _session: CaBundle | null = null;
const _hostCertCache = new Map<string, HostCert>();

// @peculiar/x509 needs a WebCrypto provider registered
const { subtle } = globalThis.crypto;
x509.cryptoProvider.set(globalThis.crypto);

async function generateCaKeypair() {
  const keyPair = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );

  const skiExt = await x509.SubjectKeyIdentifierExtension.create(keyPair.publicKey);

  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=actharness-ca',
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    keys: keyPair,
    extensions: [
      skiExt,
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
    ],
  });

  return { cert, keyPair };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function exportPem(key: any): Promise<string> {
  const buf = await subtle.exportKey('pkcs8', key);
  const b64 = Buffer.from(buf).toString('base64');
  const lines = b64.match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
}

export async function ensureSessionCa(): Promise<CaBundle> {
  if (_session) return _session;

  const { cert, keyPair } = await generateCaKeypair();
  const certPem = cert.toString('pem');
  const keyPem = await exportPem(keyPair.privateKey);

  const id = randomUUID();
  const certPath = join(tmpdir(), `actharness-ca-${id}.crt`);
  const keyPath = join(tmpdir(), `actharness-ca-${id}.key`);
  writeFileSync(certPath, certPem, { mode: 0o600 });
  writeFileSync(keyPath, keyPem, { mode: 0o600 });

  _session = { certPem, keyPem, certPath, keyPath };
  return _session;
}

export async function signHostCert(hostname: string, ca: CaBundle): Promise<HostCert> {
  const cached = _hostCertCache.get(hostname);
  if (cached) return cached;

  const keyPair = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );

  const caCert = new x509.X509Certificate(ca.certPem);
  const caKeyRaw = ca.keyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const caKeyBuf = Buffer.from(caKeyRaw, 'base64');
  const caKey = await subtle.importKey(
    'pkcs8',
    caKeyBuf,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  const skiExt = await x509.SubjectKeyIdentifierExtension.create(keyPair.publicKey);
  const akiExt = await x509.AuthorityKeyIdentifierExtension.create(caCert.publicKey);

  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomUUID().replace(/-/g, '').slice(0, 16),
    issuer: caCert.issuerName,
    subject: `CN=${hostname}`,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 24 * 60 * 60 * 1000),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    publicKey: keyPair.publicKey,
    signingKey: caKey,
    extensions: [
      skiExt,
      akiExt,
      new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: hostname }]),
      new x509.BasicConstraintsExtension(false),
    ],
  });

  const certPem = cert.toString('pem');
  const keyPem = await exportPem(keyPair.privateKey);

  const result: HostCert = { certPem, keyPem };
  _hostCertCache.set(hostname, result);
  return result;
}

export function cleanupSessionCa(): void {
  if (!_session) return;
  try { unlinkSync(_session.certPath); } catch { /* best-effort */ }
  try { unlinkSync(_session.keyPath); } catch { /* best-effort */ }
  _session = null;
  _hostCertCache.clear();
}
