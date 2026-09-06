import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/types.ts";

interface RenderThemeLike {
	fg(color: string, value: string): string;
	bold(value: string): string;
}

interface RenderComponentLike {
	render(width: number): string[];
}

interface RegisteredToolLike {
	name: string;
	renderCall?: (args: unknown, theme: RenderThemeLike, context: Record<string, unknown>) => RenderComponentLike;
	renderResult?: (
		result: unknown,
		options: unknown,
		theme: RenderThemeLike,
		context?: Record<string, unknown>,
	) => RenderComponentLike;
	execute?: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: { cwd: string },
	) => Promise<unknown>;
}

function buildConfig(overrides: Partial<ToolDisplayConfig> = {}): ToolDisplayConfig {
	return {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		...overrides,
		registerToolOverrides: {
			...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,
			...overrides.registerToolOverrides,
		},
	};
}

function createTheme(): RenderThemeLike {
	return {
		fg: (_color: string, value: string): string => value,
		bold(value: string): string {
			return value;
		},
	};
}

function normalizeRenderedText(component: RenderComponentLike): string {
	return component
		.render(120)
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function createExtensionApiStub(): { api: ExtensionAPI; registeredTools: RegisteredToolLike[] } {
	const registeredTools: RegisteredToolLike[] = [];
	const api = {
		registerTool(tool: RegisteredToolLike): void {
			registeredTools.push(tool);
		},
		on(): void {},
		getAllTools(): unknown[] {
			return [
				{ name: "read", sourceInfo: { source: "builtin", path: "<builtin:read>" } },
				{ name: "edit", sourceInfo: { source: "builtin", path: "<builtin:edit>" } },
			];
		},
	} as unknown as ExtensionAPI;
	return { api, registeredTools };
}

test("semantic bash call headers classify common inspection commands", () => {
	const { api, registeredTools } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => buildConfig());
	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	assert.ok(bashTool?.renderCall);

	const context = {
		executionStarted: false,
		isPartial: false,
		state: {},
		invalidate: () => {},
	};
	assert.equal(
		normalizeRenderedText(bashTool.renderCall({ command: "cat README.md" }, createTheme(), context)),
		"read README.md",
	);
	assert.equal(
		normalizeRenderedText(bashTool.renderCall({ command: "npm test" }, createTheme(), context)),
		"$ npm test",
	);
});

test("raw bash call mode keeps classified commands as $ command", () => {
	const { api, registeredTools } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => buildConfig({ bashCallMode: "raw" }));
	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	assert.ok(bashTool?.renderCall);

	const output = normalizeRenderedText(
		bashTool.renderCall(
			{ command: "cat README.md" },
			createTheme(),
			{ executionStarted: false, isPartial: false, state: {}, invalidate: () => {} },
		),
	);
	assert.equal(output, "$ cat README.md");
});

test("semantic bash exploring results stay hidden in the opencode preset", () => {
	const { api, registeredTools } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => buildConfig());
	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	assert.ok(bashTool?.renderResult);

	const rendered = normalizeRenderedText(
		bashTool.renderResult(
			{ content: [{ type: "text", text: "file contents\nmore\n" }], details: {}, isError: false },
			{ isPartial: false, expanded: false },
			createTheme(),
			{ args: { command: "cat README.md" } },
		),
	);
	assert.equal(rendered, "");
});

test("semantic bash exploring results reveal the original command when expanded", () => {
	const { api, registeredTools } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => buildConfig());
	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	assert.ok(bashTool?.renderResult);

	const rendered = normalizeRenderedText(
		bashTool.renderResult(
			{ content: [{ type: "text", text: "file contents\n" }], details: {}, isError: false },
			{ isPartial: false, expanded: true },
			createTheme(),
			{ args: { command: "cat README.md" } },
		),
	);
	assert.match(rendered, /^\$ cat README.md/);
	assert.match(rendered, /file contents/);
});

test("inline python writes snapshot the file and render an edit diff", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-tool-display-python-edit-"));
	try {
		writeFileSync(join(dir, "note.txt"), "before\n", "utf8");
		const { api, registeredTools } = createExtensionApiStub();
		registerToolDisplayOverrides(api, () => buildConfig());
		const bashTool = registeredTools.find((tool) => tool.name === "bash");
		assert.ok(bashTool?.execute);
		assert.ok(bashTool.renderResult);
		assert.ok(bashTool.renderCall);

		const command = `python3 -c "from pathlib import Path; Path('note.txt').write_text('after\\n')"`;
		const toolCallId = "bash-edit-1";
		await bashTool.execute(toolCallId, { command }, undefined, () => {}, { cwd: dir });
		assert.equal(readFileSync(join(dir, "note.txt"), "utf8"), "after\n");

		const state: Record<string, unknown> = {};
		const call = normalizeRenderedText(
			bashTool.renderCall(
				{ command },
				createTheme(),
				{ executionStarted: true, isPartial: false, state, toolCallId, cwd: dir, invalidate: () => {} },
			),
		);
		assert.equal(call, "edit note.txt");

		const result = normalizeRenderedText(
			bashTool.renderResult(
				{ content: [{ type: "text", text: "" }], details: {}, isError: false },
				{ isPartial: false, expanded: false },
				createTheme(),
				{ args: { command }, toolCallId, state, cwd: dir },
			),
		);
		assert.match(result, /note\.txt|after|before/);
		assert.doesNotMatch(result, /python3 -c/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
