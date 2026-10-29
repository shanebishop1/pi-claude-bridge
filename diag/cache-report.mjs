#!/usr/bin/env node
// Prompt-cache report from saved sessions: pi's claude-bridge turns, with
// interactive Claude Code as the baseline. Reads only files that already exist
// (no debug log or trace needed), so it can be run any time over past usage.
//
//   node diag/cache-report.mjs [--since 7d|YYYY-MM-DD] [--no-baseline] [--json]
//       [--pi-sessions DIR]... [--claude-projects DIR] [--max-break-rate 0.05]
//
// Each request is compared with the request it continues: in pi its nearest
// assistant ancestor along parentId (so /tree branches compare with the turn they
// grew from), in Claude Code the previous request in the same transcript. The
// cache that request left behind is cacheRead + cacheWrite; a follow-up that reads
// back more than MIN_SHORTFALL less than that lost cache. A loss is "expected"
// when compaction or a model change sits between the two, "idle" when the gap is
// longer than the 5-minute TTL (Claude Code sometimes gets 1h, so idle losses
// under an hour are not proof of a bug), and "unexpected" otherwise. Unexpected
// losses are the bridge-health signal; compare their rate with the baseline.
//
// Claude Code transcripts: only `entrypoint: "cli"` records count, so the
// bridge's own child sessions (sdk-ts) and other SDK hosts stay out of the
// baseline. Sidechains (subagents) are skipped on both sides.
//
// --max-break-rate exits 1 when the bridge's unexpected-loss rate (per follow-up
// request) is above it, for use from cron or CI.

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// Matches Claude Code's own cache-break detector, which ignores smaller drops.
export const MIN_SHORTFALL = 2_000;
export const TTL_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const BRIDGE_PROVIDER = "claude-bridge";

/** One request: tokens, its continuation verdict and where it came from. */
function request({ file, line, session, ts, model, input, cacheRead, cacheWrite }) {
	return { file, line, session, ts, model, input, cacheRead, cacheWrite, kind: "first", shortfall: 0 };
}

/** Classify r as a continuation of prev, given what lay between them. */
export function classify(r, prev, { compacted = false, modelChanged = false } = {}) {
	if (!prev) return r;
	const expected = prev.cacheRead + prev.cacheWrite;
	r.shortfall = Math.max(0, expected - r.cacheRead);
	const gap = Date.parse(r.ts) - Date.parse(prev.ts);
	if (r.shortfall <= MIN_SHORTFALL) r.kind = "hit";
	else if (compacted) r.kind = "compaction";
	else if (modelChanged || prev.model !== r.model) r.kind = "model-change";
	else if (gap > HOUR_MS) r.kind = "idle>1h";
	else if (gap > TTL_MS) r.kind = "idle>5m";
	else r.kind = "unexpected";
	return r;
}

async function* lines(file) {
	const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
	let n = 0;
	for await (const text of rl) {
		n++;
		if (!text.startsWith("{")) continue;
		try { yield [n, JSON.parse(text)]; } catch {}
	}
}

/** pi session file -> bridge requests. Entries form a tree via parentId. */
export async function piRequests(file) {
	const byId = new Map();
	const order = [];
	let session = file;
	for await (const [line, e] of lines(file)) {
		if (e.type === "session") session = e.id ?? file;
		if (!e.id) continue;
		byId.set(e.id, { e, line });
		order.push(e.id);
	}
	const usageOf = (e) => e.type === "message" && e.message?.role === "assistant" && e.message.usage;
	const counts = (u) => u && (u.input || u.cacheRead || u.cacheWrite);
	const out = [];
	const built = new Map();
	for (const id of order) {
		const { e, line } = byId.get(id);
		const u = usageOf(e);
		if (!counts(u) || e.message.provider !== BRIDGE_PROVIDER) continue;
		const r = request({ file, line, session, ts: e.timestamp, model: e.message.model, input: u.input ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 });
		// Walk up to the nearest assistant message that made a request.
		let compacted = false, modelChanged = false, prev = null, otherProvider = false;
		for (let p = e.parentId; p && byId.has(p); p = byId.get(p).e.parentId) {
			const pe = byId.get(p).e;
			if (pe.type === "compaction" || pe.type === "branch_summary") compacted = true;
			if (pe.type === "model_change") modelChanged = true;
			const pu = usageOf(pe);
			if (counts(pu)) {
				if (pe.message.provider !== BRIDGE_PROVIDER) otherProvider = true;
				else prev = built.get(p) ?? null;
				break;
			}
		}
		classify(r, prev, { compacted, modelChanged: modelChanged || otherProvider });
		if (otherProvider) r.kind = "first";
		built.set(id, r);
		out.push(r);
	}
	return out;
}

/** Claude Code transcript -> interactive (cli) requests, one per requestId. */
export async function claudeRequests(file) {
	const out = [];
	const index = new Map();
	let prev = null, compacted = false;
	for await (const [line, e] of lines(file)) {
		if (e.isSidechain) continue;
		if (e.type === "system" && e.subtype === "compact_boundary") { compacted = true; continue; }
		if (e.type !== "assistant" || e.entrypoint !== "cli") continue;
		const u = e.message?.usage;
		const model = e.message?.model;
		if (!u || !model || model === "<synthetic>") continue;
		const key = e.requestId ?? e.message.id ?? `${file}:${line}`;
		const fields = { input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
		const seen = index.get(key);
		// A request's content blocks are separate records; the last carries final usage.
		if (seen) { Object.assign(seen, fields); continue; }
		const r = request({ file, line, session: e.sessionId ?? file, ts: e.timestamp, model, ...fields });
		index.set(key, r);
		out.push({ r, prev, compacted });
		prev = r;
		compacted = false;
	}
	// Classify after usage is final.
	return out.map(({ r, prev, compacted }) => classify(r, prev, { compacted }));
}

function jsonlFiles(dir, sinceMs) {
	const found = [];
	const walk = (d) => {
		let entries;
		try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
		for (const ent of entries) {
			const p = join(d, ent.name);
			// Claude Code keeps subagent transcripts under <session>/subagents.
			if (ent.isDirectory()) { if (ent.name !== "subagents") walk(p); }
			else if (ent.name.endsWith(".jsonl") && statSync(p).mtimeMs >= sinceMs) found.push(p);
		}
	};
	if (existsSync(dir)) walk(dir);
	return found;
}

export function summarize(requests) {
	const sum = (rs, f) => rs.reduce((a, r) => a + f(r), 0);
	const prompt = (r) => r.input + r.cacheRead + r.cacheWrite;
	const follow = requests.filter((r) => r.kind !== "first");
	const kinds = {};
	for (const r of follow) {
		const k = (kinds[r.kind] ??= { count: 0, lostTokens: 0 });
		k.count++;
		k.lostTokens += r.kind === "hit" ? 0 : r.shortfall;
	}
	const ratio = (a, b) => (b ? a / b : null);
	return {
		sessions: new Set(requests.map((r) => r.session)).size,
		requests: requests.length,
		promptTokens: sum(requests, prompt),
		hitRate: ratio(sum(requests, (r) => r.cacheRead), sum(requests, prompt)),
		followUpHitRate: ratio(sum(follow, (r) => r.cacheRead), sum(follow, prompt)),
		followUps: follow.length,
		unexpectedRate: ratio(kinds.unexpected?.count ?? 0, follow.length),
		kinds,
	};
}

function byDay(requests) {
	const days = new Map();
	for (const r of requests) {
		const d = (r.ts ?? "").slice(0, 10);
		if (!days.has(d)) days.set(d, []);
		days.get(d).push(r);
	}
	return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, rs]) => ({ day, ...summarize(rs) }));
}

const pct = (x) => (x == null ? "  n/a" : `${(x * 100).toFixed(1).padStart(5)}%`);
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n));

function print(title, requests) {
	const s = summarize(requests);
	console.log(`\n${title}`);
	if (!s.requests) return console.log("  no requests in range");
	console.log(`  ${s.sessions} sessions, ${s.requests} requests, ${k(s.promptTokens)} prompt tokens`);
	console.log(`  cache hit rate, all requests     ${pct(s.hitRate)}`);
	console.log(`  cache hit rate, follow-ups only  ${pct(s.followUpHitRate)}`);
	console.log(`  unexpected cache losses          ${s.kinds.unexpected?.count ?? 0} of ${s.followUps} follow-ups (${pct(s.unexpectedRate).trim()}), ${k(s.kinds.unexpected?.lostTokens ?? 0)} tokens re-written`);
	const other = Object.entries(s.kinds).filter(([n]) => n !== "hit" && n !== "unexpected");
	if (other.length) console.log(`  other re-caches                  ${other.map(([n, v]) => `${n} ${v.count}`).join(", ")}`);
	console.log("  by day:       hit  follow-up  unexpected  requests");
	for (const d of byDay(requests)) console.log(`    ${d.day}  ${pct(d.hitRate)}     ${pct(d.followUpHitRate)}   ${String(d.kinds.unexpected?.count ?? 0).padStart(5)}      ${String(d.requests).padStart(6)}`);
	const worst = requests.filter((r) => r.kind === "unexpected").sort((a, b) => b.shortfall - a.shortfall).slice(0, 5);
	if (worst.length) {
		console.log("  largest unexpected losses:");
		for (const r of worst) console.log(`    ${r.ts}  -${k(r.shortfall)}  ${r.model}  ${r.file}:${r.line}`);
	}
}

function parseSince(value) {
	if (!value) return Date.now() - 7 * 24 * HOUR_MS;
	const rel = /^(\d+)([dh])$/.exec(value);
	if (rel) return Date.now() - Number(rel[1]) * (rel[2] === "d" ? 24 : 1) * HOUR_MS;
	const t = Date.parse(value);
	if (Number.isNaN(t)) throw new Error(`bad --since ${value}`);
	return t;
}

async function main() {
	const args = process.argv.slice(2);
	const flag = (name) => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : args[i + 1]; };
	const flags = (name) => args.flatMap((a, i) => (a === `--${name}` && i + 1 < args.length ? [args[i + 1]] : []));
	const sinceMs = parseSince(flag("since"));
	const inRange = (r) => Date.parse(r.ts) >= sinceMs;
	// Repeatable: e.g. the personal agent dir plus a Gas City private HOME's.
	const piDirs = flags("pi-sessions");
	if (!piDirs.length) piDirs.push(join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions"));
	const piDir = piDirs.join(", ");
	const ccDir = flag("claude-projects") ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");

	const bridge = [];
	for (const dir of piDirs) for (const f of jsonlFiles(dir, sinceMs)) bridge.push(...(await piRequests(f)).filter(inRange));
	const baseline = [];
	if (!args.includes("--no-baseline")) for (const f of jsonlFiles(ccDir, sinceMs)) baseline.push(...(await claudeRequests(f)).filter(inRange));

	const since = new Date(sinceMs).toISOString().slice(0, 16).replace("T", " ");
	if (args.includes("--json")) {
		console.log(JSON.stringify({ since, bridge: { ...summarize(bridge), byDay: byDay(bridge) }, baseline: { ...summarize(baseline), byDay: byDay(baseline) } }, null, 1));
	} else {
		console.log(`Prompt-cache report since ${since}  (loss = >${k(MIN_SHORTFALL)} tokens less read back than the previous request cached)`);
		print(`pi + claude-bridge  (${piDir})`, bridge);
		if (!args.includes("--no-baseline")) print(`vanilla Claude Code, interactive cli  (${ccDir})`, baseline);
	}
	const max = flag("max-break-rate");
	const rate = summarize(bridge).unexpectedRate;
	if (max != null && rate != null && rate > Number(max)) {
		console.error(`\nunexpected-loss rate ${pct(rate).trim()} is above --max-break-rate ${max}`);
		process.exitCode = 1;
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
