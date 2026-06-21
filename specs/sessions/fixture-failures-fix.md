# Fixture test failures — root causes and fixes

Four tests in `fixtures/` still fail after the network-mock fixture assertion cleanup. Each has a distinct root cause.

---

## 1 · Test C — Python HTTPS (`python-https.yml`)

Two separate failures, fixed in order:

### 1a — `ModuleNotFoundError: No module named 'requests'`

`requests` is a third-party library not installed in the test environment. The fixture assumed it was available.

**Fix:** Rewrite `fixtures/network-mock/python-https.yml` to use `urllib.request` (stdlib only). `urllib.request.build_opener` includes `ProxyHandler` by default, which reads `HTTPS_PROXY` / `https_proxy` from the environment and performs the CONNECT tunnel transparently.

### 1b — `SSL: CERTIFICATE_VERIFY_FAILED: Missing Authority Key Identifier`

After switching to `urllib.request`, the step still failed. Python 3.14 uses OpenSSL 3.6, which enforces RFC 5280 strictly and rejects certs without an Authority Key Identifier extension. macOS curl uses LibreSSL/SecureTransport which does not enforce this — which is why curl tests passed while Python did not.

**Root cause:** `packages/network-mock/src/ca-cert.ts` generated certs without the AKI/SKI extensions:

- CA cert: lacked `SubjectKeyIdentifierExtension`
- Host cert (dynamically signed per hostname): lacked `SubjectKeyIdentifierExtension` and `AuthorityKeyIdentifierExtension`

**Fix:** Add the missing extensions using `@peculiar/x509` static factory methods:

```ts
// CA cert (generateCaKeypair)
const skiExt = await x509.SubjectKeyIdentifierExtension.create(keyPair.publicKey);
extensions: [skiExt, new x509.BasicConstraintsExtension(true, ...), ...]

// Host cert (signHostCert)
const skiExt = await x509.SubjectKeyIdentifierExtension.create(keyPair.publicKey);
const akiExt = await x509.AuthorityKeyIdentifierExtension.create(caCert.publicKey);
extensions: [skiExt, akiExt, new x509.SubjectAlternativeNameExtension(...), ...]
```

`caCert.publicKey` is the `PublicKey` object from `new x509.X509Certificate(ca.certPem)` — already instantiated in `signHostCert` for signing. No extra parsing needed.

The urllib.request script:

```python
import urllib.request, os, ssl

ca = os.environ.get('SSL_CERT_FILE') or os.environ.get('CURL_CA_BUNDLE', '')
ctx = ssl.create_default_context()
if ca:
    ctx.load_verify_locations(ca)

opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))
with opener.open('https://api.example.com/data') as r:
    body = r.read().decode()

with open(os.environ['GITHUB_OUTPUT'], 'a') as f:
    f.write(f'body={body}\n')
```

---

## 2 · Test E — sh wget HTTPS (`sh-https.yml`)

**Error:** `wget: command not found`

`wget` is not installed on macOS by default. The fixture assumed a Linux-like environment.

**Fix:** Rewrite `fixtures/network-mock/sh-https.yml` to use `curl` instead. The proxy env already sets `CURL_CA_BUNDLE` so no extra certificate handling is needed.

New step script:
```sh
body=$(curl -sf https://api.example.com/data)
echo "body=$body" >> "$GITHUB_OUTPUT"
```

Expected output is `{"value":"from-wget"}` — same format as the bash fixtures. The test assertion stays the same.

---

## 3 · Test J — unmatched request returns 502 (`bash-unmatched.yml`)

**Error:** `Expected step 'fetch' to have failed, but conclusion was 'success'.`

Two compounding issues:

**a)** `continue-on-error: true` causes `step-runner.ts` line 429 to override the conclusion:
```ts
const conclusion = outcome === 'failure' && continueOnError ? 'success' : outcome;
```
So even when the step fails (outcome = 'failure'), the conclusion is 'success'. The assertion `expect(result.step('fetch')).toHaveFailed()` therefore always fails for any `continue-on-error` step.

**b)** The script used `curl -sf` + bash `-eo pipefail`, which exits immediately when curl fails — the `echo "curl-exit=$?"` line is never reached and there is no output to check.

**Fix:** Remove `continue-on-error` and rewrite the step to capture the HTTP status code without failing, using `curl -s -o /dev/null -w "%{http_code}"`. This writes the numeric HTTP status to stdout and always exits 0 (transport errors would still fail, but the proxy is reachable).

New fixture YAML (`bash-unmatched.yml`):
```yaml
name: Network Mock — unmatched request blocked
description: Fixture J — no mock registered, proxy returns 502

outputs:
  status:
    description: HTTP status code returned by the proxy
    value: ${{ steps.fetch.outputs.status }}

runs:
  using: composite
  steps:
    - id: fetch
      shell: bash
      run: |
        status=$(curl -s -o /dev/null -w "%{http_code}" https://real-server.com/api)
        echo "status=$status" >> "$GITHUB_OUTPUT"
```

New test assertion:
```ts
expect(result).toHaveSucceeded();
expect(result).toHaveOutput('status', '502');
```

---

## 4 · test-level mock overrides file-level mock (`global-mocks.test.ts`)

**Error:** `Expected output 'status' to equal "file-status", but got "".`

**Root cause:** `register.ts` registers a global `afterEach`:
```ts
afterEach(() => { globalResetMocks(); resetNetworkMocks(); });
```

`afterEach` in `lifecycle.ts` captures `currentStack()` at registration time. Since this runs at file-root level (no ALS context), `capturedStack = [fileRootRegistry]`. When the hook fires, `scopeALS.run([fileRootRegistry], fn)` is the active context, so `currentScope()` = `fileRootRegistry`.

`globalResetMocks()` then calls `fileRootRegistry.resetMocks()` — which deletes every file-level mock. After test 1, the `actions/status-check@v1` mock is gone, so test 2 sees `status = ""`.

**Why this is wrong:** file-level mocks are supposed to persist for the entire test file. The ephemeral test scope (created by `runInTestScope` per test) already provides automatic isolation for test-level mocks — they die with the ALS context. Describe-level mocks and file-root mocks are the user's responsibility to clear via their own `afterEach`.

**Fix:** Remove `globalResetMocks()` from the global `afterEach` in `register.ts`. Keep `resetNetworkMocks()` (network mocks must still be cleared between tests). The change in register.ts:

```ts
// before
afterEach(() => { globalResetMocks(); resetNetworkMocks(); });

// after
afterEach(() => { resetNetworkMocks(); });
```
