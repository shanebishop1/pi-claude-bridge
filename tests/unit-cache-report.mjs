import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeRequests, piRequests, summarize } from "../diag/cache-report.mjs";

const dir = mkdtempSync(join(tmpdir(), "cache-report-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const write = (name, entries) => {
	const file = join(dir, name);
	writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
	return file;
};
const t = (s) => new Date(Date.UTC(2026, 9, 29, 0, 0, s)).toISOString();
const assistant = (id, parentId, ts, cacheRead, cacheWrite, extra = {}) => ({
	type: "message", id, parentId, timestamp: ts,
	message: { role: "assistant", provider: "claude-bridge", model: "claude-haiku-5-5", usage: { input: 2, cacheRead, cacheWrite }, ...extra },
});
const user = (id, parentId) => ({ type: "message", id, parentId, message: { role: "user" } });

describe("piRequests", () => {
	it("compares each request with its tree ancestor, not the previous line", async () => {
		const file = write("tree.jsonl", [
			{ type: "session", id: "s1" },
			user("u1", null),
			assistant("a1", "u1", t(0), 0, 10_000),
			user("u2", "a1"),
			assistant("a2", "u2", t(10), 10_000, 5_000),
			// /tree back to a1: this branch must compare with a1 (10k cached), not a2 (15k).
			user("u3", "a1"),
			assistant("a3", "u3", t(20), 10_000, 300),
		]);
		const rs = await piRequests(file);
		assert.deepEqual(rs.map((r) => r.kind), ["first", "hit", "hit"]);
	});

	it("labels losses by what lies between the two requests", async () => {
		const file = write("kinds.jsonl", [
			{ type: "session", id: "s2" },
			user("u1", null),
			assistant("a1", "u1", t(0), 0, 20_000),
			user("u2", "a1"),
			assistant("a2", "u2", t(5), 3_000, 17_000), // lost 17k with nothing in between
			{ type: "compaction", id: "c1", parentId: "a2" },
			user("u3", "c1"),
			assistant("a3", "u3", t(10), 3_000, 4_000),
			user("u4", "a3"),
			assistant("a4", "u4", t(10 + 600), 0, 7_000), // 10 minutes idle
			user("u5", "a4"),
			// Aborted before any usage arrived: no request, skipped.
			assistant("a5", "u5", t(620), 0, 0, { stopReason: "aborted", usage: { input: 0, cacheRead: 0, cacheWrite: 0 } }),
		]);
		const rs = await piRequests(file);
		assert.deepEqual(rs.map((r) => r.kind), ["first", "unexpected", "compaction", "idle>5m"]);
		assert.equal(rs[1].shortfall, 17_000);
		const s = summarize(rs);
		assert.equal(s.followUps, 3);
		assert.equal(s.kinds.unexpected.count, 1);
	});

	it("ignores other providers' turns and restarts the chain after them", async () => {
		const file = write("mixed.jsonl", [
			{ type: "session", id: "s3" },
			user("u1", null),
			{ ...assistant("a1", "u1", t(0), 0, 9_000), message: { role: "assistant", provider: "openai-codex", model: "gpt", usage: { input: 9_000, cacheRead: 0, cacheWrite: 0 } } },
			user("u2", "a1"),
			assistant("a2", "u2", t(5), 0, 12_000),
		]);
		const rs = await piRequests(file);
		assert.deepEqual(rs.map((r) => r.kind), ["first"]);
	});
});

describe("claudeRequests", () => {
	it("keeps interactive cli requests, one per requestId, with final usage", async () => {
		const rec = (requestId, ts, read, write, extra = {}) => ({
			type: "assistant", entrypoint: "cli", sessionId: "c1", requestId, timestamp: ts,
			message: { model: "claude-opus-5-5", usage: { input_tokens: 1, cache_read_input_tokens: read, cache_creation_input_tokens: write } }, ...extra,
		});
		const file = write("cc.jsonl", [
			rec("r1", t(0), 0, 100),
			rec("r1", t(0), 0, 10_000), // same request, later block: final usage
			rec("r2", t(5), 10_000, 200),
			rec("x1", t(6), 0, 50_000, { entrypoint: "sdk-ts" }), // bridge child: excluded
			rec("x2", t(6), 0, 50_000, { isSidechain: true }), // subagent: excluded
			{ type: "system", subtype: "compact_boundary" },
			rec("r3", t(9), 0, 4_000),
		]);
		const rs = await claudeRequests(file);
		assert.deepEqual(rs.map((r) => [r.kind, r.cacheWrite]), [["first", 10_000], ["hit", 200], ["compaction", 4_000]]);
	});
});
