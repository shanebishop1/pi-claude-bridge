# Auto-compaction window probe

Measured 2026-10-30 with Claude Agent SDK 0.3.308 and its bundled Claude Code
2.1.308, using `claude-sonnet-5-5[1m]`. No transcript inference or large prompt
was used. The bridge's provider runs with `DISABLE_AUTO_COMPACT=1` because pi
owns compaction.

## Tiny live turns

Each case sent `Reply with just: OK`, with `tools: []`, strict MCP config,
`persistSession: false`, and `DISABLE_AUTO_COMPACT=1`.
The same three cases also reported 1,000,000 with the separately installed
Claude Code 2.1.314 executable selected through `pathToClaudeCodeExecutable`.

| Settings | `result.modelUsage[model].contextWindow` | Result |
| --- | ---: | --- |
| Default setting sources; user `autoCompactWindow: 400000` | 1,000,000 | success |
| Same, plus `CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000` | 1,000,000 | success |
| `settingSources: []`, no window environment override | 1,000,000 | success |

## Local blocking probe

A local stub API answered a tiny first request with artificial input-token
usage. A second tiny turn tested whether Claude Code sent another request or
blocked locally. This measures the local guard without sending hundreds of
thousands of tokens to the real API.

| Settings | Injected input tokens | Requests received | Second result |
| --- | ---: | ---: | --- |
| User settings as above | 380,000 | 2 | success |
| Environment override as above | 380,000 | 2 | success |
| No user settings | 380,000 | 2 | success |
| No user settings (blocking control) | 980,000 | 1 | `Prompt is too long` |

380,000 is above the 377,000 blocking point that a 400,000 window would imply
after the bridge's conservative 23,000-token reserve. The successful second
request rules out that lowered blocking ceiling on this version. The 980,000
control confirms that the probe does exercise Claude Code's local guard; it
does not remeasure its exact boundary.

A reproducible offline contract uses the same injected usage with a second user
turn and an explicit SDK setting rather than relying on local settings:

```sh
node --import tsx --test --test-name-pattern='autoCompactWindow does not lower' tests/int-cc-contracts.mjs
```

## Provider policy

There is no observed lower blocking ceiling to synchronize with the child or
latent dead band caused by the user's compaction setting on this version.
`provider.autoCompactWindow` therefore controls pi's registered window only;
it does not set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` or read Claude Code's settings.
When absent, the existing served-window policy is unchanged. This avoids
silently coupling pi's compaction policy to another application's preferences
or model-specific `auto` tuning.

For a 1M model with `provider.autoCompactWindow: 400000`, registration is
`min(1000000, 400000) - 23000 = 377000`. Pi's default reserve of 16,384 makes
its compaction threshold 360,616. The runtime model still uses `[1m]` and its
display label still says 1M. Recheck the contract after SDK or executable
upgrades; these results do not prove behavior of other versions or that
`DISABLE_AUTO_COMPACT` prevents actual automatic compaction near a full window.
