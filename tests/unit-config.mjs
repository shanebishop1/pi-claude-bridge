import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { claudeCodeSettings, loadConfig, markAskClaudeDeprecationNoticeShown, markStartupNoticeShown } from "../src/config.js";

function withTempHome(fn) {
	const oldHome = process.env.HOME;
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const home = mkdtempSync(join(tmpdir(), "claude-bridge-home-"));
	try {
		process.env.HOME = home;
		process.env.PI_CODING_AGENT_DIR = join(home, "agent");
		return fn(home);
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(home, { recursive: true, force: true });
	}
}

describe("claudeCodeSettings", () => {
	it("disables auto-memory by default", () => {
		assert.deepEqual(claudeCodeSettings(), { autoMemoryEnabled: false });
	});

	it("allows auto-memory to be enabled", () => {
		assert.deepEqual(claudeCodeSettings({ autoMemoryEnabled: true }), { autoMemoryEnabled: true });
	});
});

describe("loadConfig", () => {
	it("loads project config from Pi's configured project directory", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const configDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(configDir, { recursive: true });
			writeFileSync(join(configDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "max" },
				askClaude: { enabled: false },
			}));

			assert.deepEqual(loadConfig(cwd), {
				startupNoticeShown: undefined,
				askClaudeDeprecationShown: undefined,
				provider: { plan: "max" },
				askClaude: { enabled: false },
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("merges project config over global config", () => withTempHome((home) => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const globalDir = getAgentDir();
			const projectDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(globalDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(globalDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "pro", strictMcpConfig: true, autoCompactWindow: 600000 },
				askClaude: { enabled: true, defaultMode: "read" },
			}));
			writeFileSync(join(projectDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "max", autoMemoryEnabled: true, autoCompactWindow: 400000 },
				askClaude: { enabled: false },
			}));

			assert.deepEqual(loadConfig(cwd), {
				startupNoticeShown: undefined,
				askClaudeDeprecationShown: undefined,
				provider: { plan: "max", strictMcpConfig: true, autoMemoryEnabled: true, autoCompactWindow: 400000 },
				askClaude: { enabled: false, defaultMode: "read" },
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("accepts positive integer autoCompactWindow values from global config", () => withTempHome(() => {
		const dir = getAgentDir();
		mkdirSync(dir, { recursive: true });
		for (const autoCompactWindow of [1, 100000, 400000, 1000000, Number.MAX_SAFE_INTEGER]) {
			writeFileSync(join(dir, "claude-bridge.json"), JSON.stringify({ provider: { autoCompactWindow } }));
			assert.equal(loadConfig(dir).provider.autoCompactWindow, autoCompactWindow);
		}
	}));

	it("ignores invalid autoCompactWindow values without dropping other settings", () => withTempHome(() => {
		const dir = getAgentDir();
		mkdirSync(dir, { recursive: true });
		const errors = [];
		const original = console.error;
		console.error = (...args) => errors.push(args.join(" "));
		try {
			for (const autoCompactWindow of [null, 0, -1, 1.5, "400000", "auto", true, [], {}, Number.MAX_SAFE_INTEGER + 1]) {
				writeFileSync(join(dir, "claude-bridge.json"), JSON.stringify({ provider: { autoCompactWindow, plan: "max" } }));
				assert.deepEqual(loadConfig(dir).provider, { plan: "max" });
			}
			assert.equal(errors.length, 10);
			assert.ok(errors.every((error) => /provider\.autoCompactWindow.*positive integer.*ignoring/.test(error)));
		} finally {
			console.error = original;
		}
	}));

	it("accepts settingSources as a list of distinct Claude Code sources", () => withTempHome(() => {
		const dir = getAgentDir();
		mkdirSync(dir, { recursive: true });
		for (const settingSources of [[], ["user"], ["user", "project"], ["local", "project", "user"]]) {
			writeFileSync(join(dir, "claude-bridge.json"), JSON.stringify({ provider: { settingSources } }));
			assert.deepEqual(loadConfig(dir).provider.settingSources, settingSources);
		}
	}));

	it("narrows an invalid settingSources to no sources without dropping other settings", () => withTempHome(() => {
		const dir = getAgentDir();
		mkdirSync(dir, { recursive: true });
		const errors = [];
		const original = console.error;
		console.error = (...args) => errors.push(args.join(" "));
		try {
			const invalid = [null, "user", {}, true, ["policy"], ["user", "user"], ["User"], [1], [["user"]]];
			for (const settingSources of invalid) {
				writeFileSync(join(dir, "claude-bridge.json"), JSON.stringify({ provider: { settingSources, plan: "max" } }));
				assert.deepEqual(loadConfig(dir).provider, { plan: "max", settingSources: [] });
			}
			assert.equal(errors.length, invalid.length);
			assert.ok(errors.every((error) => /provider\.settingSources.*using \[\]/.test(error)));
		} finally {
			console.error = original;
		}
	}));

	it("an invalid project settingSources never widens the global one", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		const original = console.error;
		console.error = () => {};
		try {
			mkdirSync(getAgentDir(), { recursive: true });
			mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
			writeFileSync(join(getAgentDir(), "claude-bridge.json"), JSON.stringify({ provider: { settingSources: ["user"] } }));
			for (const settingSources of [null, "project", ["policy"], ["user", "user"]]) {
				writeFileSync(join(cwd, CONFIG_DIR_NAME, "claude-bridge.json"), JSON.stringify({ provider: { settingSources } }));
				assert.deepEqual(loadConfig(cwd).provider.settingSources, [], JSON.stringify(settingSources));
			}
		} finally {
			console.error = original;
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("markStartupNoticeShown records today's date without dropping existing settings", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const globalDir = getAgentDir();
			mkdirSync(globalDir, { recursive: true });
			const path = join(globalDir, "claude-bridge.json");
			writeFileSync(path, JSON.stringify({
				askClaude: { enabled: false },
				provider: { strictMcpConfig: false },
			}));

			assert.equal(markStartupNoticeShown(), path);
			const written = JSON.parse(readFileSync(path, "utf-8"));
			assert.match(written.startupNoticeShown, /^\d{4}-\d{2}-\d{2}$/);
			assert.deepEqual(written.askClaude, { enabled: false });
			assert.deepEqual(written.provider, { strictMcpConfig: false });
			assert.equal(loadConfig(cwd).startupNoticeShown, written.startupNoticeShown);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("markAskClaudeDeprecationNoticeShown records today's date without dropping settings", () => withTempHome(() => {
		const globalDir = getAgentDir();
		mkdirSync(globalDir, { recursive: true });
		const path = join(globalDir, "claude-bridge.json");
		writeFileSync(path, JSON.stringify({ askClaude: { enabled: true } }));

		markAskClaudeDeprecationNoticeShown();
		const written = JSON.parse(readFileSync(path, "utf-8"));
		assert.match(written.askClaudeDeprecationShown, /^\d{4}-\d{2}-\d{2}$/);
		assert.deepEqual(written.askClaude, { enabled: true });
	}));

	it("markStartupNoticeShown leaves an unparseable config untouched", () => withTempHome(() => {
		const globalDir = getAgentDir();
		mkdirSync(globalDir, { recursive: true });
		const path = join(globalDir, "claude-bridge.json");
		const malformed = '{ "askClaude": { "enabled": true }, }';
		writeFileSync(path, malformed);

		markStartupNoticeShown();
		assert.equal(readFileSync(path, "utf-8"), malformed, "a typo must not cost the user their config");
	}));

	it("markStartupNoticeShown creates the config when there is none", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			assert.equal(loadConfig(cwd).startupNoticeShown, undefined);
			markStartupNoticeShown();
			assert.match(loadConfig(cwd).startupNoticeShown, /^\d{4}-\d{2}-\d{2}$/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("resolves global config via PI_CODING_AGENT_DIR override, not hardcoded ~/.pi/agent", () => withTempHome(() => {
		const agentDir = mkdtempSync(join(tmpdir(), "claude-bridge-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		const oldEnv = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "max" },
			}));

			assert.deepEqual(loadConfig(cwd), {
				startupNoticeShown: undefined,
				askClaudeDeprecationShown: undefined,
				provider: { plan: "max" },
				askClaude: {},
			});
		} finally {
			if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldEnv;
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	}));
});
