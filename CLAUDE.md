# Claude Code instructions

## Memory

DONT ADD INSTRUCTION TO MEMORY

## Running npm scripts

Always redirect npm/npx script output to a file so you can read the full result without truncation:

```bash
npx playwright test 2>&1 | tee /tmp/pw-result.txt; cat /tmp/pw-result.txt
npm test 2>&1 | tee /tmp/test-result.txt; cat /tmp/test-result.txt
```

Never pipe directly to `tail` — if the output is long, failures will be truncated and missed.

## No self-made design decisions

Never invent architectural or behavioral decisions that are not confirmed by the user. Ask the user first.

## Always ask before implementing

Never start writing or changing code based on a strategy discussion. Wait for the user to explicitly say to proceed.

- Do NOT fill the gap with your own judgment.
- Stop and ask the user what the correct behavior should be.
- NEVER USER GIT COMMANDS.
- NEVER MAKE DECISIONS. NEVER.
