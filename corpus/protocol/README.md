# Runner-protocol conformance corpus (seed)

Pins the stdout workflow-command encoding and the env-file formats. See [docs/PROTOCOL.md](../../docs/PROTOCOL.md). Sources in [NOTICE](NOTICE) (toolkit + runner, MIT).

## `commands.json`
Each case round-trips a stdout workflow command.
```jsonc
type CommandCase = {
  call?:   { command: string; properties?: object; message?: string };  // producer input
  line:    string;        // exact stdout the toolkit emits (encode target)
  parsed:  { command: string; properties: object; message: string };    // decode target
};
```
Gate: `encode(call) === line` and `decode(line)` deep-equals `parsed`. (When `call` is omitted, the case is decode-only — an edge that pins the **`%25`-decoded-last** rule.)

## `env-files.json`
Each case parses appended env-file content.
```jsonc
type EnvFileCase = {
  file: "GITHUB_OUTPUT" | "GITHUB_ENV" | "GITHUB_STATE" | "GITHUB_PATH" | "GITHUB_STEP_SUMMARY";
  append: string;          // raw bytes appended to the file (\n line-separated)
  expect?: object | string[];   // parsed key→value, or ordered path list
  error?:  string;         // OR: malformed (e.g. value contains its delimiter)
};
```
The heredoc delimiter is written as the literal `ghadelimiter_UUID` placeholder; a parser keys off `NAME<<DELIM … DELIM`, not a fixed UUID.
