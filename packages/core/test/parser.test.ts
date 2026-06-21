import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseDocument, YAMLMap, Scalar, Pair } from 'yaml';
import { parseAction, parseActionYaml, scalarRange, strRecord, parseInputs } from '../src/parser.js';
import { ParseError, ConfigError } from '../src/errors.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');

describe('parseAction', () => {
  it('parses a valid composite action manifest', () => {
    const action = parseAction(join(FIXTURES, 'simple-composite'));

    expect(action.name).toBe('Simple Composite Action');
    expect(action.description).toBe('A simple composite action for testing');
    expect(action.runs.using).toBe('composite');
    expect(action.runs.steps).toHaveLength(1);

    const step = action.runs.steps![0]!;
    expect(step.id).toBe('greet');
    expect(step.name).toBe('Greet');
    expect(step.shell).toBe('bash');
  });

  it('sets _file and _dir on the parsed action', () => {
    const dir = join(FIXTURES, 'simple-composite');
    const action = parseAction(dir);

    expect(action._dir).toBe(dir);
    expect(action._file).toMatch(/action\.yml$/);
  });

  it('parses inputs with defaults', () => {
    const action = parseAction(join(FIXTURES, 'simple-composite'));

    expect(action.inputs?.['name']).toMatchObject({ required: true });
    expect(action.inputs?.['greeting']).toMatchObject({ default: 'Hello' });
  });

  it('parses outputs with value expressions', () => {
    const action = parseAction(join(FIXTURES, 'simple-composite'));

    expect(action.outputs?.['message']?.value).toBe(
      '${{ steps.greet.outputs.message }}',
    );
  });

  it('throws ParseError when action.yml is missing', () => {
    expect(() => parseAction('/nonexistent/path/to/action'))
      .toThrow(ParseError);
  });

  it('throws ParseError when runs field is missing', () => {
    expect(() => parseAction(join(FIXTURES, 'no-runs'))).toThrow(ParseError);
  });

  it('loads action.yaml (not .yml) when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'actharness-yaml-'));
    writeFileSync(
      join(dir, 'action.yaml'),
      'name: Yaml Action\nruns:\n  using: composite\n  steps: []\n',
    );
    const action = parseAction(dir);
    expect(action.name).toBe('Yaml Action');
  });

  it('throws ParseError when .yml path does not exist', () => {
    // Source ends in .yml but file doesn't exist → readFileSync throws → caught → ParseError
    expect(() => parseAction('/nonexistent/path/action.yml')).toThrow(ParseError);
  });

  it('parses a node22 action without error', () => {
    const action = parseAction(join(FIXTURES, 'node-action'));
    expect(action.runs.using).toBe('node22');
  });

  it('accepts .yml path directly', () => {
    const action = parseAction(join(FIXTURES, 'simple-composite', 'action.yml'));
    expect(action.name).toBe('Simple Composite Action');
  });
});

describe('parseActionYaml', () => {
  it('throws ParseError when runs.using is missing', () => {
    const yaml = `name: T\nruns:\n  steps: []\n`;
    expect(() => parseActionYaml(yaml, '/fake/action.yml', '/fake')).toThrow(ParseError);
  });

  it('parses input with null definition (bare key with no properties)', () => {
    const yaml = `
name: T
inputs:
  myinput:
runs:
  using: composite
  steps: []
`;
    const action = parseActionYaml(yaml, '/fake/action.yml', '/fake');
    expect(action.inputs?.['myinput']).toBeDefined();
  });

  it('throws ParseError on malformed YAML', () => {
    expect(() =>
      parseActionYaml('{ bad yaml: [unclosed', '/fake/action.yml', '/fake'),
    ).toThrow(ParseError);
  });

  it('throws ParseError on empty document', () => {
    expect(() =>
      parseActionYaml('', '/fake/action.yml', '/fake'),
    ).toThrow(ParseError);
  });

  it('parses a composite action from YAML string', () => {
    const yaml = `
name: Test
runs:
  using: composite
  steps:
    - run: echo hi
      shell: bash
`;
    const action = parseActionYaml(yaml, '/fake/action.yml', '/fake');
    expect(action.name).toBe('Test');
    expect(action.runs.using).toBe('composite');
    expect(action.runs.steps).toHaveLength(1);
  });

  it('sets _range on steps', () => {
    const yaml = `
name: Test
runs:
  using: composite
  steps:
    - id: s1
      run: echo hi
      shell: bash
`;
    const action = parseActionYaml(yaml, '/fake/action.yml', '/fake');
    const step = action.runs.steps![0]!;
    // Range should be set (byte offsets into source)
    expect(step._range).toBeDefined();
    expect(typeof step._range?.start).toBe('number');
    expect(typeof step._range?.end).toBe('number');
  });

  it('throws ConfigError for docker executor', () => {
    const yaml = `
name: Docker Action
runs:
  using: docker
  image: Dockerfile
`;
    expect(() => parseActionYaml(yaml, '/fake/action.yml', '/fake')).toThrow(ConfigError);
  });

  it('parses step env and with fields', () => {
    const yaml = `
name: Test
runs:
  using: composite
  steps:
    - uses: actions/checkout@v4
      with:
        token: \${{ secrets.TOKEN }}
        fetch-depth: '1'
      env:
        MY_VAR: hello
`;
    const action = parseActionYaml(yaml, '/fake/action.yml', '/fake');
    const step = action.runs.steps![0]!;
    expect(step.uses).toBe('actions/checkout@v4');
    expect(step.with?.['token']).toBe('${{ secrets.TOKEN }}');
    expect(step.with?.['fetch-depth']).toBe('1');
    expect(step.env?.['MY_VAR']).toBe('hello');
  });

  it('parses step continue-on-error boolean', () => {
    const yaml = `
name: Test
runs:
  using: composite
  steps:
    - run: exit 1
      shell: bash
      continue-on-error: true
`;
    const action = parseActionYaml(yaml, '/fake/action.yml', '/fake');
    const step = action.runs.steps![0]!;
    expect(step['continue-on-error']).toBe(true);
  });

  it('action without name field uses empty string', () => {
    // covers `str(root, 'name') ?? ''` fallback
    const yaml = `runs:\n  using: composite\n  steps: []\n`;
    const action = parseActionYaml(yaml, '/fake/action.yml', '/fake');
    expect(action.name).toBe('');
  });

  it('action with description field', () => {
    const yaml = `name: T\ndescription: My action\nruns:\n  using: composite\n  steps: []\n`;
    const action = parseActionYaml(yaml, '/fake/action.yml', '/fake');
    expect(action.description).toBe('My action');
  });

  it('parses output with value but no description', () => {
    const yaml = `
name: T
outputs:
  myout:
    value: \${{ steps.foo.outputs.result }}
runs:
  using: composite
  steps: []
`;
    const action = parseActionYaml(yaml, '/fake/action.yml', '/fake');
    expect(action.outputs?.['myout']?.value).toBe('${{ steps.foo.outputs.result }}');
    expect(action.outputs?.['myout']?.description).toBeUndefined();
  });

  it('parses output with description but no value', () => {
    const yaml = `
name: T
outputs:
  myout:
    description: An output description
runs:
  using: composite
  steps: []
`;
    const action = parseActionYaml(yaml, '/fake/action.yml', '/fake');
    expect(action.outputs?.['myout']?.description).toBe('An output description');
    expect(action.outputs?.['myout']?.value).toBeUndefined();
  });

  it('parses output without value or description (null output def)', () => {
    // output with bare key → def is null → if (def && 'get' in def) → false branch
    const yaml = `
name: T
outputs:
  myout:
runs:
  using: composite
  steps: []
`;
    const action = parseActionYaml(yaml, '/fake/action.yml', '/fake');
    expect(action.outputs?.['myout']).toBeDefined();
  });

  it('parses runs with pre/post/main/image fields', () => {
    // covers runs optional fields for non-composite using (node-like fields parsed on composite too)
    const yaml = `
name: T
runs:
  using: composite
  steps: []
  pre: pre.js
  post: post.js
  main: main.js
  image: Dockerfile
`;
    const action = parseActionYaml(yaml, '/fake/action.yml', '/fake');
    expect(action.runs.pre).toBe('pre.js');
    expect(action.runs.post).toBe('post.js');
    expect(action.runs.main).toBe('main.js');
    expect(action.runs.image).toBe('Dockerfile');
  });

  it('parses runs with pre-if and post-if', () => {
    const yaml = `
name: T
runs:
  using: composite
  steps: []
  pre-if: always()
  post-if: success()
`;
    const action = parseActionYaml(yaml, '/fake/action.yml', '/fake');
    expect(action.runs['pre-if']).toBe('always()');
    expect(action.runs['post-if']).toBe('success()');
  });

  it('parses step with if: expression', () => {
    const yaml = `
name: T
runs:
  using: composite
  steps:
    - run: echo
      shell: bash
      if: success()
      working-directory: /tmp
`;
    const action = parseActionYaml(yaml, '/fake/action.yml', '/fake');
    const s = action.runs.steps![0]!;
    expect(s.if).toBe('success()');
    expect(s['working-directory']).toBe('/tmp');
  });

  it('parses input with deprecationMessage', () => {
    const yaml = `
name: T
inputs:
  old:
    description: old input
    deprecationMessage: Use new-input instead
runs:
  using: composite
  steps: []
`;
    const action = parseActionYaml(yaml, '/fake/action.yml', '/fake');
    expect(action.inputs?.['old']?.deprecationMessage).toBe('Use new-input instead');
  });

  it('outputs empty map returns undefined (no outputs in result)', () => {
    // outputs: {} → outputsNode exists but has no items → result stays empty → returns undefined
    const yaml = `name: T\noutputs: {}\nruns:\n  using: composite\n  steps: []\n`;
    const action = parseActionYaml(yaml, '/fake/action.yml', '/fake');
    expect(action.outputs).toBeUndefined();
  });

  it('steps: scalar (non-list) returns empty steps array', () => {
    // steps: "not-a-list" → stepsNode.items is not an array → returns []
    const yaml = `name: T\nruns:\n  using: composite\n  steps: not-a-list\n`;
    const action = parseActionYaml(yaml, '/fake/action.yml', '/fake');
    expect(action.runs.steps).toEqual([]);
  });

  it('null step item in sequence is skipped', () => {
    // steps: [null, {run: echo, shell: bash}] → null item is skipped
    const yaml = `
name: T
runs:
  using: composite
  steps:
    - null
    - run: echo
      shell: bash
`;
    const action = parseActionYaml(yaml, '/fake/action.yml', '/fake');
    // null step is skipped, only the real step is included
    expect(action.runs.steps?.length).toBe(1);
    expect(action.runs.steps?.[0]?.run).toBe('echo');
  });

  it('inputs empty map returns undefined', () => {
    // inputs: {} → inputsNode has no items → result stays empty → returns undefined
    const yaml = `name: T\ninputs: {}\nruns:\n  using: composite\n  steps: []\n`;
    const action = parseActionYaml(yaml, '/fake/action.yml', '/fake');
    expect(action.inputs).toBeUndefined();
  });

  it('null value in step with map becomes empty string', () => {
    // with:\n  token:\n → pair.value.value is null → String(null ?? '') = ''
    const yaml = `
name: T
runs:
  using: composite
  steps:
    - uses: actions/checkout@v4
      with:
        token:
`;
    const action = parseActionYaml(yaml, '/fake/action.yml', '/fake');
    expect(action.runs.steps![0]?.with?.['token']).toBe('');
  });

  it('scalarRange returns undefined when key is absent from the map', () => {
    const doc = parseDocument('key: value', { keepSourceTokens: true });
    const map = doc.contents as YAMLMap;
    expect(scalarRange(map, 'missing')).toBeUndefined();
  });

  it('strRecord skips pair when value node is null', () => {
    const outer = new YAMLMap();
    const inner = new YAMLMap();
    inner.items.push(new Pair(new Scalar('key'), null) as unknown as typeof inner.items[0]);
    outer.items.push(new Pair(new Scalar('env'), inner) as unknown as typeof outer.items[0]);
    expect(strRecord(outer, 'env')).toEqual({});
  });

  it('parseInputs does not set _range when input nodes lack source range', () => {
    const inputs = new YAMLMap();
    const def = new YAMLMap();
    inputs.items.push(new Pair(new Scalar('myinput'), def) as unknown as typeof inputs.items[0]);
    const result = parseInputs(inputs);
    expect(result?.['myinput']?._range).toBeUndefined();
  });

  it('parses step continue-on-error as string expression', () => {
    const yaml = `
name: T
runs:
  using: composite
  steps:
    - run: echo
      shell: bash
      continue-on-error: 'always()'
`;
    const action = parseActionYaml(yaml, '/fake/action.yml', '/fake');
    expect(action.runs.steps![0]?.['continue-on-error']).toBe('always()');
  });

  it('parses step timeout-minutes', () => {
    const yaml = `
name: Test
runs:
  using: composite
  steps:
    - run: sleep 100
      shell: bash
      timeout-minutes: 5
`;
    const action = parseActionYaml(yaml, '/fake/action.yml', '/fake');
    const step = action.runs.steps![0]!;
    expect(step['timeout-minutes']).toBe(5);
  });

});
