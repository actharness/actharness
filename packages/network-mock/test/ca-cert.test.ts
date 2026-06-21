import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { ensureSessionCa, signHostCert, cleanupSessionCa } from '../src/ca-cert.js';

beforeEach(() => {
  cleanupSessionCa();
});

afterEach(() => {
  cleanupSessionCa();
});

// ── ensureSessionCa ───────────────────────────────────────────────────────────

describe('ensureSessionCa', () => {
  it('returns a CaBundle with PEM strings', async () => {
    const ca = await ensureSessionCa();
    expect(ca.certPem).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(ca.keyPem).toMatch(/-----BEGIN PRIVATE KEY-----/);
  });

  it('writes the cert and key to temp files', async () => {
    const ca = await ensureSessionCa();
    expect(existsSync(ca.certPath)).toBe(true);
    expect(existsSync(ca.keyPath)).toBe(true);
  });

  it('returns the same bundle on repeated calls', async () => {
    const a = await ensureSessionCa();
    const b = await ensureSessionCa();
    expect(a).toBe(b);
  });

  it('returns a new bundle after cleanupSessionCa', async () => {
    const a = await ensureSessionCa();
    cleanupSessionCa();
    const b = await ensureSessionCa();
    expect(a).not.toBe(b);
    expect(b.certPem).toMatch(/-----BEGIN CERTIFICATE-----/);
  });
});

// ── cleanupSessionCa ──────────────────────────────────────────────────────────

describe('cleanupSessionCa', () => {
  it('deletes the cert and key files', async () => {
    const ca = await ensureSessionCa();
    const { certPath, keyPath } = ca;
    cleanupSessionCa();
    expect(existsSync(certPath)).toBe(false);
    expect(existsSync(keyPath)).toBe(false);
  });

  it('is idempotent — safe to call when no session exists', () => {
    expect(() => cleanupSessionCa()).not.toThrow();
    expect(() => cleanupSessionCa()).not.toThrow();
  });
});

// ── signHostCert ──────────────────────────────────────────────────────────────

describe('signHostCert', () => {
  it('returns a cert and key signed by the CA', async () => {
    const ca = await ensureSessionCa();
    const host = await signHostCert('example.com', ca);
    expect(host.certPem).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(host.keyPem).toMatch(/-----BEGIN PRIVATE KEY-----/);
  });

  it('returns the same cert on repeated calls for the same hostname', async () => {
    const ca = await ensureSessionCa();
    const a = await signHostCert('example.com', ca);
    const b = await signHostCert('example.com', ca);
    expect(a).toBe(b);
  });

  it('returns different certs for different hostnames', async () => {
    const ca = await ensureSessionCa();
    const a = await signHostCert('example.com', ca);
    const b = await signHostCert('other.com', ca);
    expect(a.certPem).not.toBe(b.certPem);
  });

  it('host cert cache is cleared when cleanupSessionCa is called', async () => {
    const ca = await ensureSessionCa();
    const a = await signHostCert('example.com', ca);
    cleanupSessionCa();
    const ca2 = await ensureSessionCa();
    const b = await signHostCert('example.com', ca2);
    expect(a).not.toBe(b);
  });
});
