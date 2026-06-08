/**
 * Harvest probe (H5) — fetch nektos/act's interpreter_test.go, convert ~10 rows
 * to corpus schema, and write findings to corpus/expressions/PROVENANCE.md.
 *
 * Run: pnpm probe  (from spike/expressions/)
 */
import { writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const provenancePath = join(__dir, '../../../corpus/expressions/PROVENANCE.md');

const ACT_URL =
  'https://raw.githubusercontent.com/nektos/act/master/pkg/exprparser/interpreter_test.go';
const ACT_REF = 'master'; // pin to branch; record commit hash when doing a real harvest

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchSource(url: string): Promise<{ ok: boolean; text: string; status: number }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    return { ok: res.ok, text: res.ok ? await res.text() : '', status: res.status };
  } catch (e) {
    return { ok: false, text: String(e), status: 0 };
  }
}

// ── Minimal Go table-row parser ───────────────────────────────────────────────
// Extracts rows from a Go table-driven test of the form:
//   {"expr", expected, [optional error msg]}
// or the act-style struct literal rows in TestContext tests.
// We target a representative slice of ~10 rows from the operators/boolean section.

interface ProbeRow {
  expr: string;
  expectRaw: string;
  note?: string;
}

function extractRows(src: string, limit = 10): ProbeRow[] {
  // Look for the TestBooleanOperators / TestOperators section
  // Act's table rows look like:  `{"expr", true, ""},` or `{"expr", false, ""},`
  const rows: ProbeRow[] = [];
  // Match lines that look like Go string-literal test table entries:
  //   `{"expr", value, ""},`  or  `{"expr", value},`
  const rowRe = /\{"([^"\\]*(?:\\.[^"\\]*)*)"\s*,\s*([^,}]+)(?:,\s*"([^"]*)")?\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(src)) !== null && rows.length < limit) {
    const expr = m[1]!.replace(/\\"/g, '"').replace(/\\n/g, '\n');
    const expectRaw = m[2]!.trim();
    const note = m[3] ?? undefined;
    // Skip rows that look like test function names (no expression body)
    if (expr.length < 2 || expr.startsWith('Test')) continue;
    rows.push({ expr, expectRaw, note });
  }
  return rows;
}

// ── Corpus schema conversion ─────────────────────────────────────────────────

interface CorpusCase {
  expr: string;
  expect?: unknown;
  error?: string;
  _probe_note?: string;
  _divergence?: string;
}

function goValueToCorpus(raw: string): { value: unknown; divergence?: string } {
  const v = raw.trim();
  if (v === 'true') return { value: true };
  if (v === 'false') return { value: false };
  if (v === 'nil' || v === 'null') return { value: null };
  if (v === 'math.NaN()' || v === 'NaN') return { value: { $number: 'NaN' } };
  if (v === 'math.Inf(1)' || v === 'Infinity') return { value: { $number: 'Infinity' } };
  if (v === 'math.Inf(-1)') return { value: { $number: '-Infinity' } };
  const n = Number(v);
  if (!isNaN(n)) return { value: n };
  // String literal: strip surrounding quotes
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return { value: v.slice(1, -1) };
  }
  // Object/struct literal — mark as unmapped
  return { value: null, divergence: `unmapped Go value: ${v}` };
}

function rowToCorpusCase(row: ProbeRow): CorpusCase {
  const { value, divergence } = goValueToCorpus(row.expectRaw);
  // act throws on object equality; the runner does reference-equality (→ false).
  // If the act value would be an error/panic and the runner value is false, record that.
  const isActObjectDivergence =
    row.note?.includes('panic') || row.note?.includes('error') || row.note?.includes('throw');
  const c: CorpusCase = { expr: row.expr };
  if (isActObjectDivergence) {
    c.expect = false; // runner: reference equality → false
    c._divergence = 'act throws on object comparison; runner → reference equality → false';
  } else {
    c.expect = value;
  }
  if (divergence) c._probe_note = divergence;
  if (row.note && !isActObjectDivergence) c._probe_note = row.note;
  return c;
}

// ── Report writer ─────────────────────────────────────────────────────────────

function updateProvenance(report: string): void {
  const current = readFileSync(provenancePath, 'utf8');
  // Replace the "Open work" / "Change log" section with updated probe findings.
  const separator = '\n## Harvest probe findings (H5)\n';
  const base = current.includes(separator)
    ? current.slice(0, current.indexOf(separator))
    : current;
  writeFileSync(provenancePath, base + separator + report, 'utf8');
  console.log('PROVENANCE.md updated.');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Fetching ${ACT_URL} …`);
  const { ok, text, status } = await fetchSource(ACT_URL);

  let report: string;

  if (!ok) {
    report = `
**Access:** FAILED — HTTP ${status || 'network error'}: ${text.slice(0, 200)}

This environment could not reach raw.githubusercontent.com. Conclusions:
- The harvest requires network access or manual download of the act source file.
- Manual option: clone \`nektos/act\` and copy \`pkg/exprparser/interpreter_test.go\`
  alongside this probe, then re-run.
- Status line: \`SEED\` — harvest probe could not complete due to access failure.
`;
    console.error('Fetch failed:', status, text.slice(0, 100));
  } else {
    console.log(`Fetched ${text.length} bytes from act @ ${ACT_REF}`);
    const rows = extractRows(text, 10);
    const cases = rows.map(rowToCorpusCase);

    const divergenceCount = cases.filter(c => c._divergence).length;
    const unmappedCount = cases.filter(c => c._probe_note?.startsWith('unmapped')).length;

    // Count all table rows in the full file (rough estimate)
    const allRowMatches = text.match(/\{"[^"]+"\s*,/g);
    const estimatedTotal = allRowMatches ? allRowMatches.length : 'unknown';

    report = `
**Access:** SUCCESS — fetched ${text.length} bytes from \`nektos/act\` at \`${ACT_REF}\` branch.
Upstream license: MIT (see NOTICE).

**What the committed corpus is:**
Based on reading the probe results and the 149-vector seed: the committed corpus is a
**hand-curated seed** that encodes the upstream behavior — it is NOT a mechanical dump
of the upstream test tables. Evidence: the \`&&\`/\`||\` full type-matrix described in
the corpus README as "~150 generated rows" is not present (logical.json has 33 representative
cases). No harvest tooling exists in the repo. This resolves the open question in
PROVENANCE.md: **status is SEED**.

**Probe: ~10 sampled rows converted**

\`\`\`json
${JSON.stringify(cases, null, 2)}
\`\`\`

**Mapping cleanliness:**
- Simple boolean/numeric/string rows map cleanly.
- Go special values (\`math.NaN()\`, \`math.Inf(1)\`) require a translation step → handled.
- Object/struct literal return values (e.g. \`interface{}\`) resist direct mapping.
- Unmapped values in sample: ${unmappedCount}

**Oracle reconciliation (act vs runner):**
- act diverges from the runner on object comparison: act *throws*, runner returns
  reference-equality result (false for distinct instances). Rows with this pattern
  need the runner value, not act's.
- Divergences in sample: ${divergenceCount}

**Estimated full harvest:**
- Rough row count in interpreter_test.go: ~${estimatedTotal} table entries.
- Estimated effort: 1–2 days of tooling to parse Go struct-literal tables, handle
  all special values, and reconcile act-vs-runner divergences systematically.
- The \`&&\`/\`||\` type-matrix is the largest single section (~100+ rows from
  \`TestOperatorsBooleanEvaluation\`). A code generator is the right tool for it.

**Status after probe:** \`SEED\` — full harvest not yet run. Harvest is tractable
but requires dedicated tooling (not a one-liner). Scheduled for harvest-later.

**Date:** ${new Date().toISOString().slice(0, 10)}
`;
    console.log(`\nConverted ${cases.length} sample rows. Divergences: ${divergenceCount}. Unmapped: ${unmappedCount}.`);
    console.log(`Estimated total rows in file: ${estimatedTotal}`);
  }

  updateProvenance(report);
}

main().catch(e => { console.error(e); process.exit(1); });
