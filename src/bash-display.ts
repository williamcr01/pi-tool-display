import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { registerCleanup, registerTimer } from "./disposable.js";
import {
	getChangedEditFiles,
	getSingleEditCommand,
	isExploringCommands,
	parseCommand,
	type BashEditFileSnapshot,
	type ParsedCommand,
} from "./parse-command.js";
import { shortenPath } from "./render-utils.js";

const BASH_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const BASH_SPINNER_INTERVAL_MS = 200;
const BASH_SPINNER_STATE_KEY = "__piToolDisplayBashSpinner";
const BASH_SPINNER_TOOL_CALL_ID_KEY = "__piToolDisplayBashSpinnerToolCallId";

interface BashCallArgs {
	command?: string;
	commandPrefix?: string;
	shellPath?: string;
	timeout?: number;
}

interface BashCallRenderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface BashSpinnerState {
	frameIndex: number;
	startedAt?: number;
	timer?: ReturnType<typeof setInterval>;
}

interface BashSpinnerStateCarrier {
	[BASH_SPINNER_STATE_KEY]?: BashSpinnerState;
	[BASH_SPINNER_TOOL_CALL_ID_KEY]?: string;
}

interface BashCallRenderContextLike {
	executionStarted: boolean;
	isPartial: boolean;
	invalidate?: () => void;
	lastComponent?: unknown;
	state?: unknown;
	toolCallId?: string;
	cwd?: string;
}

export interface BashCallRenderOptions {
	callMode?: "raw" | "semantic";
	editFiles?: BashEditFileSnapshot[];
}

export type { BashEditFileSnapshot };

const spinnerStatesByToolCallId = new Map<string, BashSpinnerState>();
let nextSyntheticToolCallId = 0;

function toStateCarrier(value: unknown): BashSpinnerStateCarrier | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	return value as BashSpinnerStateCarrier;
}

function getSyntheticToolCallId(carrier: BashSpinnerStateCarrier | undefined): string | undefined {
	if (!carrier) {
		return undefined;
	}

	if (!carrier[BASH_SPINNER_TOOL_CALL_ID_KEY]) {
		carrier[BASH_SPINNER_TOOL_CALL_ID_KEY] = `state:${++nextSyntheticToolCallId}`;
	}
	return carrier[BASH_SPINNER_TOOL_CALL_ID_KEY];
}

function getToolCallId(context: BashCallRenderContextLike): string | undefined {
	if (typeof context.toolCallId === "string" && context.toolCallId.trim().length > 0) {
		return context.toolCallId;
	}
	return getSyntheticToolCallId(toStateCarrier(context.state));
}

function getOrCreateSpinnerState(
	toolCallId: string | undefined,
	carrier: BashSpinnerStateCarrier | undefined,
): BashSpinnerState | undefined {
	if (!toolCallId) {
		return undefined;
	}

	let state = spinnerStatesByToolCallId.get(toolCallId);
	if (!state) {
		state = { frameIndex: 0 };
		spinnerStatesByToolCallId.set(toolCallId, state);
	}
	if (carrier) {
		carrier[BASH_SPINNER_STATE_KEY] = state;
	}
	return state;
}

function stopSpinner(toolCallId: string | undefined, state: BashSpinnerState | undefined): void {
	if (!state) {
		return;
	}

	if (state.timer) {
		clearInterval(state.timer);
		state.timer = undefined;
	}
	state.frameIndex = 0;
	state.startedAt = undefined;
	if (toolCallId) {
		spinnerStatesByToolCallId.delete(toolCallId);
	}
}

function formatElapsed(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}

	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) {
		return `${totalMinutes}m ${seconds}s`;
	}

	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${hours}h ${minutes}m`;
}

function isDefaultShellPath(shellPath: string): boolean {
	const normalized = shellPath.trim().replace(/\\/g, "/").toLowerCase();
	const basename = normalized.split("/").pop() || normalized;
	return basename === "bash" || basename === "cmd.exe";
}

function buildCommandDisplay(args: BashCallArgs): string {
	const command =
		typeof args.command === "string" && args.command.trim().length > 0
			? args.command
			: "...";
	const prefix =
		typeof args.commandPrefix === "string" && args.commandPrefix.trim().length > 0
			? args.commandPrefix.trim()
			: "";
	return prefix ? `${prefix} ${command}` : command;
}

function buildRawBashCallText(
	args: BashCallArgs,
	theme: BashCallRenderTheme,
	spinnerFrame?: string,
	elapsedMs?: number,
): string {
	const commandDisplay = buildCommandDisplay(args);
	const shellSuffix =
		typeof args.shellPath === "string" &&
		args.shellPath.trim().length > 0 &&
		!isDefaultShellPath(args.shellPath)
			? theme.fg("muted", ` [shell: ${args.shellPath}]`)
			: "";
	const timeoutSuffix = args.timeout
		? theme.fg("muted", ` (timeout ${args.timeout}s)`)
		: "";
	const spinnerPrefix = spinnerFrame ? `${theme.fg("warning", `${spinnerFrame} `)}` : "";
	const elapsedSuffix =
		spinnerFrame && elapsedMs !== undefined
			? theme.fg("muted", ` · ${formatElapsed(elapsedMs)}`)
			: "";

	return `${spinnerPrefix}${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("accent", commandDisplay)}${shellSuffix}${timeoutSuffix}${elapsedSuffix}`;
}

function fileExistedOnDisk(path: string, cwd: string | undefined): boolean | undefined {
	if (!cwd) {
		return undefined;
	}
	try {
		const resolved = isAbsolute(path) ? path : resolve(cwd, path);
		return existsSync(resolved);
	} catch {
		return undefined;
	}
}

function formatParsedCallLabel(
	parsed: ParsedCommand,
	theme: BashCallRenderTheme,
	cwd: string | undefined,
	editFiles: BashEditFileSnapshot[] | undefined,
): string {
	if (parsed.type === "read") {
		return `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", parsed.name)}`;
	}
	if (parsed.type === "list") {
		return `${theme.fg("toolTitle", theme.bold("list"))} ${theme.fg("accent", parsed.path || ".")}`;
	}
	if (parsed.type === "search") {
		const query = parsed.query ? `/${parsed.query}/` : parsed.cmd;
		const suffix = parsed.path ? ` in ${parsed.path}` : "";
		return `${theme.fg("toolTitle", theme.bold("search"))} ${theme.fg("accent", query)}${theme.fg("muted", suffix)}`;
	}
	if (parsed.type !== "edit") {
		return `${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("accent", parsed.cmd)}`;
	}

	const labels = parsed.paths.map((path) => {
		const snapshot = editFiles?.find((file) => file.path === path);
		const existed = snapshot?.fileExistedBeforeWrite ?? fileExistedOnDisk(path, cwd);
		const verb = existed === false ? "write" : "edit";
		return `${theme.fg("toolTitle", theme.bold(verb))} ${theme.fg("accent", shortenPath(path) || path)}`;
	});
	return labels.join(theme.fg("muted", " · "));
}

function buildSemanticBashCallText(
	args: BashCallArgs,
	theme: BashCallRenderTheme,
	context: BashCallRenderContextLike,
	options: BashCallRenderOptions,
	spinnerFrame?: string,
	elapsedMs?: number,
): string | undefined {
	const command = typeof args.command === "string" ? args.command : "";
	const parsed = parseCommand(command);
	const edit = getSingleEditCommand(parsed);
	const spinning = Boolean(spinnerFrame);
	if (edit) {
		const changed = options.editFiles ? getChangedEditFiles(options.editFiles) : [];
		if (!spinning && options.editFiles && changed.length === 0) {
			return undefined;
		}
		const files = changed.length > 0 ? changed : options.editFiles;
		return formatSemanticLine(formatParsedCallLabel(edit, theme, context.cwd, files), theme, spinnerFrame, elapsedMs);
	}
	if (!isExploringCommands(parsed)) {
		return undefined;
	}
	const label = parsed
		.map((item) => formatParsedCallLabel(item, theme, context.cwd, options.editFiles))
		.join(theme.fg("muted", " · "));
	return formatSemanticLine(label, theme, spinnerFrame, elapsedMs);
}

function formatSemanticLine(
	label: string,
	theme: BashCallRenderTheme,
	spinnerFrame?: string,
	elapsedMs?: number,
): string {
	const spinnerPrefix = spinnerFrame ? `${theme.fg("warning", `${spinnerFrame} `)}` : "";
	const elapsedSuffix =
		spinnerFrame && elapsedMs !== undefined
			? theme.fg("muted", ` · ${formatElapsed(elapsedMs)}`)
			: "";
	return `${spinnerPrefix}${label}${elapsedSuffix}`;
}

function buildBashCallText(
	args: BashCallArgs,
	theme: BashCallRenderTheme,
	context: BashCallRenderContextLike,
	options: BashCallRenderOptions,
	spinnerFrame?: string,
	elapsedMs?: number,
): string {
	if (options.callMode === "semantic") {
		const semantic = buildSemanticBashCallText(args, theme, context, options, spinnerFrame, elapsedMs);
		if (semantic) {
			return semantic;
		}
	}
	return buildRawBashCallText(args, theme, spinnerFrame, elapsedMs);
}

export function renderBashCall(
	args: BashCallArgs,
	theme: BashCallRenderTheme,
	context: BashCallRenderContextLike,
	options: BashCallRenderOptions = {},
): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	const carrier = toStateCarrier(context.state);
	const toolCallId = getToolCallId(context);
	const spinnerState = getOrCreateSpinnerState(toolCallId, carrier);
	const shouldSpin = context.executionStarted && context.isPartial;

	if (!shouldSpin) {
		stopSpinner(toolCallId, spinnerState);
		text.setText(buildBashCallText(args, theme, context, options));
		return text;
	}

	if (spinnerState) {
		spinnerState.startedAt ??= Date.now();
		if (!spinnerState.timer && typeof context.invalidate === "function") {
			const timer = setInterval(() => {
				spinnerState.frameIndex = (spinnerState.frameIndex + 1) % BASH_SPINNER_FRAMES.length;
				text.setText(
					buildBashCallText(
						args,
						theme,
						context,
						options,
						BASH_SPINNER_FRAMES[spinnerState.frameIndex],
						Date.now() - (spinnerState.startedAt ?? Date.now()),
					),
				);
				context.invalidate?.();
			}, BASH_SPINNER_INTERVAL_MS);
			spinnerState.timer = timer;
			registerTimer(timer);
			registerCleanup(() => {
				if (spinnerStatesByToolCallId.get(toolCallId || "") === spinnerState) {
					stopSpinner(toolCallId, spinnerState);
				}
			});
		}
	}

	const spinnerFrame = spinnerState ? BASH_SPINNER_FRAMES[spinnerState.frameIndex] : undefined;
	const elapsedMs = spinnerState?.startedAt !== undefined
		? Date.now() - spinnerState.startedAt
		: undefined;
	text.setText(buildBashCallText(args, theme, context, options, spinnerFrame, elapsedMs));
	return text;
}
