// User-facing extension config. Loaded once at extension registration from
// the global agent dir (getAgentDir(), e.g. ~/.pi/agent/claude-bridge.json)
// and the project Pi config directory, project overriding global. Missing or
// unparseable files are ignored (error to console.error, empty object
// returned) so the extension always starts.

import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export interface Config {
	/** Date (YYYY-MM-DD) the one-time startup notice was shown. Written by the extension, not the user. */
	startupNoticeShown?: string;
	/** Date (YYYY-MM-DD) the AskClaude deprecation notice was shown. Written by the extension, not the user. */
	askClaudeDeprecationShown?: string;
	askClaude?: {
		enabled?: boolean;
		name?: string;
		label?: string;
		description?: string;
		defaultMode?: "full" | "read" | "none";
		defaultIsolated?: boolean;
		allowFullMode?: boolean;
		appendSkills?: boolean;
	};
	/** Low-level Claude Agent SDK plumbing. Most users won't need these. */
	provider?: {
		strictMcpConfig?: boolean;
		autoMemoryEnabled?: boolean;
		pathToClaudeCodeExecutable?: string;
		// Subscription plan tier. Setting to "max" enables Opus 4.6 at 1M context
		plan?: "pro" | "max";
		// Set to true to opt into metered 1M context usage ("extra usage" in
		// Anthropic billing). Enables Sonnet 4.6 [1m] on every plan and Opus 4.6
		// [1m] on Pro.
		longContextExtraUsage?: boolean;
		// Model ids (e.g. "claude-future-9") whose declared 1M context Claude Code
		// does not actually serve; pins them to the bare id at 200K.
		forceTwoHundredK?: string[];
		// Optional token window for pi's auto-compaction; does not change the
		// served model id or Claude Code's own compaction settings.
		autoCompactWindow?: number;
		// Claude Code settings sources for the provider's queries (unset: Claude Code's
		// default, every source). ["user"] skips the project's .claude/settings.json and
		// .claude/settings.local.json (their hooks, env and apiKeyHelper).
		settingSources?: SettingSource[];
	};
}

const SETTING_SOURCES: readonly string[] = ["user", "project", "local"] satisfies SettingSource[];

export function tryParseJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		console.error(`claude-bridge: failed to parse ${path}: ${e}`);
		return {};
	}
}

export function claudeCodeSettings(provider: Config["provider"] = {}): { autoMemoryEnabled: boolean } {
	return { autoMemoryEnabled: provider.autoMemoryEnabled ?? false };
}

export function globalConfigPath(): string {
	return join(getAgentDir(), "claude-bridge.json");
}

/** Record today's date in the global config so the startup notice shows once, preserving every
 *  other field. Returns the config path for display either way.
 *
 *  Parses directly rather than through tryParseJson, which reports an unparseable file as `{}`:
 *  spreading that would replace a user's whole config with just this marker the first time they
 *  leave a trailing comma in it. Losing the notice is the cheaper failure, so the write is
 *  skipped and the notice simply shows again next session. */
export function markStartupNoticeShown(): string {
	const path = globalConfigPath();
	let existing: Partial<Config> = {};
	if (existsSync(path)) {
		try {
			existing = JSON.parse(readFileSync(path, "utf-8"));
		} catch (e) {
			console.error(`claude-bridge: leaving ${path} alone, it does not parse: ${e}`);
			return path;
		}
	}
	// en-CA renders YYYY-MM-DD in local time; toISOString() would report UTC.
	const next = { ...existing, startupNoticeShown: new Date().toLocaleDateString("en-CA") };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
	return path;
}

/** Record when the AskClaude deprecation notice was shown in the global config, preserving every
 *  other field. Returns the config path either way. */
export function markAskClaudeDeprecationNoticeShown(): string {
	const path = globalConfigPath();
	let existing: Partial<Config> = {};
	if (existsSync(path)) {
		try {
			existing = JSON.parse(readFileSync(path, "utf-8"));
		} catch (e) {
			console.error(`claude-bridge: leaving ${path} alone, it does not parse: ${e}`);
			return path;
		}
	}
	// Match startupNoticeShown's local YYYY-MM-DD date format.
	const next = { ...existing, askClaudeDeprecationShown: new Date().toLocaleDateString("en-CA") };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
	return path;
}

export function loadConfig(cwd: string): Config {
	const global = tryParseJson(globalConfigPath());
	const project = tryParseJson(join(cwd, CONFIG_DIR_NAME, "claude-bridge.json"));
	const provider = { ...global.provider, ...project.provider };
	if (provider.autoCompactWindow !== undefined &&
		(!Number.isSafeInteger(provider.autoCompactWindow) || provider.autoCompactWindow <= 0)) {
		console.error("claude-bridge: provider.autoCompactWindow must be a positive integer token count; ignoring it");
		delete provider.autoCompactWindow;
	}
	const sources: unknown = provider.settingSources;
	if (sources !== undefined && (!Array.isArray(sources) || new Set(sources).size !== sources.length ||
		!sources.every((source) => typeof source === "string" && SETTING_SOURCES.includes(source)))) {
		console.error('claude-bridge: provider.settingSources must be an array of distinct "user", "project" or "local"; ignoring it');
		delete provider.settingSources;
	}
	return {
		startupNoticeShown: project.startupNoticeShown ?? global.startupNoticeShown,
		askClaudeDeprecationShown: project.askClaudeDeprecationShown ?? global.askClaudeDeprecationShown,
		askClaude: { ...global.askClaude, ...project.askClaude },
		provider,
	};
}
