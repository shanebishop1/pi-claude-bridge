/**
 * provider.settingSources reaches the provider path's query() as given, and its
 * absence leaves Claude Code's default; CLAUDE.local.md is excluded like CLAUDE.md.
 * Drives the real provider entry with a fake SDK query.
 */
import { it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const mod = await import("../src/index.js");
const { setQuery, resetSharedSession } = mod.__test;
const configPath = join(getAgentDir(), "claude-bridge.json");
let provider;

const ev = (event) => ({ type: "stream_event", event });
const text = [
	ev({ type: "message_start", message: { id: "msg_text", usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
	ev({ type: "message_stop" }),
];

/** Register the extension with `config` as its global config, run one turn, return the query options. */
async function providerQueryOptions(config) {
	mkdirSync(getAgentDir(), { recursive: true });
	if (config === undefined) rmSync(configPath, { force: true });
	else writeFileSync(configPath, JSON.stringify(config));
	// Each registration re-reads the config; only the first registers the provider (later
	// instances defer to session_start), and both share the same provider settings.
	mod.default({ on: () => {}, registerProvider: (_name, value) => { provider = value; }, registerTool: () => {} });
	resetSharedSession();
	const seen = [];
	setQuery(({ prompt, options }) => {
		seen.push(options);
		const gen = (async function* () {
			await prompt[Symbol.asyncIterator]().next();
			const id = options.sessionId ?? options.resume;
			yield { type: "system", subtype: "init", session_id: id, claude_code_version: "test" };
			for (const step of text) yield step;
			yield { type: "result", subtype: "success", session_id: id, result: "done", usage: { input_tokens: 1 } };
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
	const message = await provider.streamSimple(provider.models[0], { messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [] },
		{ sessionId: `setting-sources-${Math.random()}`, signal: new AbortController().signal }).result();
	assert.equal(message.stopReason, "stop", JSON.stringify(message));
	assert.equal(seen.length, 1);
	return seen[0];
}

afterEach(() => {
	setQuery(null);
	rmSync(configPath, { force: true });
});

it("leaves settingSources at Claude Code's default when unset", async () => {
	const options = await providerQueryOptions(undefined);
	assert.equal("settingSources" in options, false);
	assert.ok(options.settings.claudeMdExcludes.includes("**/CLAUDE.md"));
	assert.ok(options.settings.claudeMdExcludes.includes("**/CLAUDE.local.md"), "CLAUDE.local.md is excluded like CLAUDE.md");
});

it("passes the configured settingSources to the provider query", async () => {
	for (const sources of [["user"], [], ["user", "project", "local"]]) {
		const options = await providerQueryOptions({ provider: { settingSources: sources } });
		assert.deepEqual(options.settingSources, sources);
	}
});

it("drops an invalid settingSources rather than passing it on", async () => {
	const original = console.error;
	console.error = () => {};
	try {
		const options = await providerQueryOptions({ provider: { settingSources: ["user", "policy"] } });
		assert.equal("settingSources" in options, false);
	} finally {
		console.error = original;
	}
});
