export type ParsedCommand =
	| { type: "read"; cmd: string; name: string; path: string }
	| { type: "list"; cmd: string; path?: string }
	| { type: "search"; cmd: string; query?: string; path?: string }
	| { type: "edit"; cmd: string; paths: string[] }
	| { type: "unknown"; cmd: string };

export interface BashEditFileSnapshot {
	path: string;
	fileExistedBeforeWrite: boolean;
	previousContent?: string;
	nextContent?: string;
}

const PYTHON_HEREDOC_PATTERN =
	/^(?:cd\s+(?:--\s+)?(?:'[^']+'|"[^"]+"|[^\s;&|]+)\s*(?:&&|;)\s*)*(python3?(?:\.\d+)?)\s+(?:-\s+)?<<-?\s*(['"]?)(\w+)\2\s*\n([\s\S]*?)\n\3\s*$/;
const PYTHON_WRITE_PATTERNS = [
	/\.write_text\s*\(/,
	/\.write_bytes\s*\(/,
	/\bopen\s*\([^;\n]{0,200}?,\s*['"](?:w|a|x|wb|wt|w\+|a\+|x\+)['"]/,
	/\bjson\.dump\s*\(/,
];
const PYTHON_WALK_PATTERNS = [
	/\bos\.walk\s*\(/,
	/\bos\.listdir\s*\(/,
	/\bos\.scandir\s*\(/,
	/\bglob\.glob\s*\(/,
	/\bglob\.iglob\s*\(/,
	/\.rglob\s*\(/,
];
const PYTHON_SIDE_EFFECT_PATTERNS = [
	/\bsubprocess\b/,
	/\bos\.system\s*\(/,
	/\bos\.popen\s*\(/,
	/\bos\.execv/,
	/\bPopen\s*\(/,
];
const PATH_EXTENSION_PATTERN = /\.[A-Za-z0-9]{1,8}$/;
const NON_PATH_STRINGS = new Set([
	"utf-8",
	"utf8",
	"ascii",
	"latin-1",
	"strict",
	"replace",
	"ignore",
	"posix",
	"nt",
	"w",
	"wt",
	"wb",
	"w+",
	"r",
	"rt",
	"rb",
	"r+",
	"a",
	"at",
	"ab",
	"a+",
	"x",
	"xt",
	"xb",
]);
const ALWAYS_FORMATTING = new Set(["wc", "tr", "cut", "sort", "uniq", "tee", "column", "yes", "printf"]);
const SEARCH_COMMANDS = new Set(["grep", "egrep", "fgrep", "ag", "ack", "pt"]);
const LIST_DIRECTORY_COMMANDS = new Set(["ls", "eza", "exa"]);
const PYTHON_BARE_FLAGS = new Set(["-u", "-B", "-E", "-O", "-OO", "-s", "-S", "-v", "-I", "-q"]);
const MAX_EDIT_PATHS = 3;
const MAX_EDIT_PATH_LENGTH = 240;

export function parseCommand(command: string): ParsedCommand[] {
	const trimmed = command.trim();
	if (!trimmed) {
		return [{ type: "unknown", cmd: command }];
	}

	const heredoc = extractPythonHeredoc(trimmed);
	if (heredoc) {
		return [classifyPythonScript(heredoc.script, trimmed)];
	}

	const tokens = tokenize(stripStderrRedirects(trimmed));
	if (!tokens) {
		return [{ type: "unknown", cmd: trimmed }];
	}

	return parseTokens(tokens, trimmed);
}

export function isExploringCommands(parsed: ParsedCommand[]): boolean {
	return (
		parsed.length > 0 &&
		parsed.every((item) => item.type === "read" || item.type === "list" || item.type === "search")
	);
}

export function getSingleEditCommand(
	parsed: ParsedCommand[],
): Extract<ParsedCommand, { type: "edit" }> | undefined {
	const first = parsed[0];
	if (parsed.length === 1 && first?.type === "edit") {
		return first;
	}
	return undefined;
}

export function getChangedEditFiles(files: BashEditFileSnapshot[]): BashEditFileSnapshot[] {
	return files.filter((file) => {
		if (typeof file.nextContent !== "string") {
			return false;
		}
		if (!file.fileExistedBeforeWrite) {
			return true;
		}
		return file.nextContent !== (file.previousContent ?? "");
	});
}

function parseTokens(tokens: string[], original: string): ParsedCommand[] {
	const unwrapped = unwrapShell(tokens);
	const working = unwrapped ?? tokens;
	if (hasStdoutRedirect(working)) {
		return [{ type: "unknown", cmd: original }];
	}

	const pythonInline = extractPythonInlineFromTokens(working);
	if (pythonInline) {
		return [classifyPythonScript(pythonInline, original)];
	}

	const parts = splitOnConnectors(working);
	const commands: ParsedCommand[] = [];
	let cwd: string | undefined;

	for (const part of parts) {
		if (part.length === 0) {
			continue;
		}
		if (executableName(part[0] ?? "") === "cd") {
			const dir = cdTarget(part.slice(1));
			if (dir) {
				cwd = cwd ? joinPaths(cwd, dir) : dir;
			}
			continue;
		}
		if (isSmallFormattingCommand(part)) {
			continue;
		}

		const parsed = summarizeMainTokens(part);
		commands.push(applyCwd(parsed, cwd));
	}

	const simplified = simplifyCommands(commands);
	if (
		simplified.length === 0 ||
		simplified.some((item) => item.type === "unknown") ||
		(simplified.some((item) => item.type === "edit") && simplified.length > 1)
	) {
		return [{ type: "unknown", cmd: original }];
	}

	return dedupeConsecutive(simplified);
}

function applyCwd(parsed: ParsedCommand, cwd: string | undefined): ParsedCommand {
	if (!cwd || parsed.type !== "read") {
		return parsed;
	}
	if (isAbsLike(parsed.path)) {
		return parsed;
	}
	const full = joinPaths(cwd, parsed.path);
	return {
		type: "read",
		cmd: parsed.cmd,
		name: shortDisplayPath(full),
		path: full,
	};
}

function simplifyCommands(commands: ParsedCommand[]): ParsedCommand[] {
	let current = commands.filter((item) => !(item.type === "unknown" && item.cmd === "true"));
	let changed = true;
	while (changed) {
		changed = false;
		if (current.length > 1 && current[0]?.type === "unknown") {
			const tokens = tokenize(current[0].cmd);
			if (tokens?.[0] === "echo") {
				current = current.slice(1);
				changed = true;
				continue;
			}
		}
	}
	return current;
}

function dedupeConsecutive(commands: ParsedCommand[]): ParsedCommand[] {
	const out: ParsedCommand[] = [];
	for (const command of commands) {
		const previous = out[out.length - 1];
		if (previous && parsedEquals(previous, command)) {
			continue;
		}
		out.push(command);
	}
	return out;
}

function parsedEquals(left: ParsedCommand, right: ParsedCommand): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function unwrapShell(tokens: string[]): string[] | undefined {
	if (tokens.length < 3) {
		return undefined;
	}
	const name = executableName(tokens[0] ?? "");
	const flag = tokens[1];
	if (!isShellName(name) || (flag !== "-c" && flag !== "-lc")) {
		return undefined;
	}
	const script = tokens[2];
	if (typeof script !== "string") {
		return undefined;
	}
	return tokenize(script) ?? [script];
}

function isShellName(name: string): boolean {
	return name === "bash" || name === "zsh" || name === "sh" || name === "dash";
}

function hasStdoutRedirect(tokens: string[]): boolean {
	return tokens.some((token) => token === ">" || token === ">>" || token === "&>" || /^>/.test(token));
}

function splitOnConnectors(tokens: string[]): string[][] {
	const parts: string[][] = [];
	let current: string[] = [];
	for (const token of tokens) {
		if (token === "|" || token === "&&" || token === "||" || token === ";") {
			if (current.length > 0) {
				parts.push(current);
				current = [];
			}
			continue;
		}
		if (token === "2>" || token === "2>>") {
			continue;
		}
		current.push(token);
	}
	if (current.length > 0) {
		parts.push(current);
	}
	return parts;
}

function summarizeMainTokens(tokens: string[]): ParsedCommand {
	const cmd = shlexJoin(tokens);
	const head = executableName(tokens[0] ?? "");
	const tail = tokens.slice(1);

	if (LIST_DIRECTORY_COMMANDS.has(head)) {
		const flags =
			head === "ls"
				? ["-I", "-w", "--block-size", "--format", "--time-style", "--color", "--quoting-style"]
				: ["-I", "--ignore-glob", "--color", "--sort", "--time-style", "--time"];
		return { type: "list", cmd, path: firstOperand(tail, flags) };
	}
	if (head === "tree") {
		return { type: "list", cmd, path: firstOperand(tail, ["-L", "-P", "-I", "--charset", "--filelimit", "--sort"]) };
	}
	if (head === "du") {
		return {
			type: "list",
			cmd,
			path: firstOperand(tail, ["-d", "--max-depth", "-B", "--block-size", "--exclude", "--time-style"]),
		};
	}
	if (head === "rg" || head === "rga" || head === "ripgrep-all") {
		return summarizeRipgrep(tokens, tail, cmd);
	}
	if (head === "git") {
		return summarizeGit(tokens, tail, cmd);
	}
	if (head === "fd") {
		return summarizeFd(tokens, tail, cmd);
	}
	if (head === "find") {
		return summarizeFind(tokens, tail, cmd);
	}
	if (SEARCH_COMMANDS.has(head)) {
		return parseGrepLike(tokens, tail, cmd);
	}
	if (head === "cat" || head === "bat" || head === "batcat" || head === "less" || head === "more") {
		const flags =
			head === "bat" || head === "batcat"
				? ["--theme", "--language", "--style", "--terminal-width", "--tabs", "--line-range", "--map-syntax"]
				: head === "less"
					? ["-p", "-P", "-x", "-y", "-z", "-j", "--pattern", "--prompt", "--tabs", "--shift", "--jump-target"]
					: [];
		const path = singleOperand(tail, flags);
		return path ? readCommand(cmd, path) : { type: "unknown", cmd };
	}
	if (head === "head" || head === "tail") {
		const path = fileOperandAfterCount(tail);
		return path ? readCommand(cmd, path) : { type: "unknown", cmd };
	}
	if (head === "awk") {
		const path = awkDataFile(tail);
		return path ? readCommand(cmd, path) : { type: "unknown", cmd };
	}
	if (head === "nl") {
		const path = firstNonFlag(skipFlagValues(tail, ["-s", "-w", "-v", "-i", "-b"]));
		return path ? readCommand(cmd, path) : { type: "unknown", cmd };
	}
	if (head === "sed") {
		if (sedHasInPlaceFlag(tail)) {
			return { type: "unknown", cmd };
		}
		const path = sedReadPath(tail);
		return path ? readCommand(cmd, path) : { type: "unknown", cmd };
	}
	if (isPythonExecutable(head)) {
		const script = extractPythonInlineFromTokens(tokens);
		if (script) {
			return classifyPythonScript(script, cmd);
		}
		return { type: "unknown", cmd };
	}

	return { type: "unknown", cmd };
}

function summarizeRipgrep(tokens: string[], tail: string[], cmd: string): ParsedCommand {
	const args = trimAtConnector(tail);
	const hasFilesFlag = args.includes("--files");
	const candidates = skipFlagValues(args, [
		"-g",
		"--glob",
		"--iglob",
		"-t",
		"--type",
		"--type-add",
		"--type-not",
		"-m",
		"--max-count",
		"-A",
		"-B",
		"-C",
		"--context",
		"--max-depth",
		"-e",
		"--regexp",
	]);
	const nonFlags = candidates.filter((token) => !token.startsWith("-"));
	if (hasFilesFlag) {
		return { type: "list", cmd, path: nonFlags[0] ? shortDisplayPath(nonFlags[0]) : undefined };
	}
	return {
		type: "search",
		cmd,
		query: nonFlags[0],
		path: nonFlags[1] ? shortDisplayPath(nonFlags[1]) : undefined,
	};
}

function summarizeGit(tokens: string[], tail: string[], cmd: string): ParsedCommand {
	const subcommand = tail[0];
	const rest = tail.slice(1);
	if (subcommand === "grep") {
		return parseGrepLike(tokens, rest, cmd);
	}
	if (subcommand === "ls-files") {
		const path = firstOperand(rest, ["--exclude", "--exclude-from", "--pathspec-from-file"]);
		return { type: "list", cmd, path };
	}
	return { type: "unknown", cmd };
}

function summarizeFd(tokens: string[], tail: string[], cmd: string): ParsedCommand {
	const args = trimAtConnector(tail);
	const candidates = skipFlagValues(args, ["-t", "--type", "-e", "--extension", "-E", "--exclude", "--search-path"]);
	const nonFlags = candidates.filter((token) => !token.startsWith("-"));
	if (nonFlags.length === 0) {
		return { type: "list", cmd };
	}
	if (nonFlags.length === 1) {
		const only = nonFlags[0] ?? "";
		if (isPathish(only)) {
			return { type: "list", cmd, path: shortDisplayPath(only) };
		}
		return { type: "search", cmd, query: only };
	}
	return {
		type: "search",
		cmd,
		query: nonFlags[0],
		path: shortDisplayPath(nonFlags[1] ?? ""),
	};
}

function summarizeFind(tokens: string[], tail: string[], cmd: string): ParsedCommand {
	const args = trimAtConnector(tail);
	let path: string | undefined;
	for (const arg of args) {
		if (!arg.startsWith("-") && arg !== "!" && arg !== "(" && arg !== ")") {
			path = shortDisplayPath(arg);
			break;
		}
	}
	let query: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "-name" || arg === "-iname" || arg === "-path" || arg === "-regex") {
			query = args[index + 1];
			break;
		}
	}
	if (query) {
		return { type: "search", cmd, query, path };
	}
	return { type: "list", cmd, path };
}

function parseGrepLike(tokens: string[], tail: string[], cmd: string): ParsedCommand {
	const args = trimAtConnector(tail);
	const operands: string[] = [];
	let pattern: string | undefined;
	let afterDoubleDash = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (afterDoubleDash) {
			operands.push(arg);
			continue;
		}
		if (arg === "--") {
			afterDoubleDash = true;
			continue;
		}
		if (arg === "-e" || arg === "--regexp" || arg === "-f" || arg === "--file") {
			const value = args[index + 1];
			if (value && pattern === undefined) {
				pattern = value;
			}
			index += 1;
			continue;
		}
		if (
			arg === "-m" ||
			arg === "--max-count" ||
			arg === "-C" ||
			arg === "--context" ||
			arg === "-A" ||
			arg === "--after-context" ||
			arg === "-B" ||
			arg === "--before-context"
		) {
			index += 1;
			continue;
		}
		if (arg.startsWith("-")) {
			continue;
		}
		operands.push(arg);
	}
	const query = pattern ?? operands[0];
	const pathIndex = pattern ? 0 : 1;
	const path = operands[pathIndex] ? shortDisplayPath(operands[pathIndex] ?? "") : undefined;
	return { type: "search", cmd, query, path };
}

function readCommand(cmd: string, path: string): ParsedCommand {
	return { type: "read", cmd, name: shortDisplayPath(path), path };
}

function classifyPythonScript(script: string, cmd: string): ParsedCommand {
	if (PYTHON_SIDE_EFFECT_PATTERNS.some((pattern) => pattern.test(script))) {
		return { type: "unknown", cmd };
	}
	if (PYTHON_WRITE_PATTERNS.some((pattern) => pattern.test(script))) {
		const paths = extractPythonPaths(script);
		if (paths.length >= 1 && paths.length <= MAX_EDIT_PATHS) {
			return { type: "edit", cmd, paths };
		}
		return { type: "unknown", cmd };
	}
	if (PYTHON_WALK_PATTERNS.some((pattern) => pattern.test(script))) {
		return { type: "list", cmd };
	}
	return { type: "unknown", cmd };
}

function stripStderrRedirects(command: string): string {
	return command.replace(/\s+2>&1\b/g, "").replace(/\s+2>\s*\/dev\/null\b/g, "");
}

function extractPythonHeredoc(command: string): { script: string } | undefined {
	const match = command.trim().replace(/\r\n/g, "\n").match(PYTHON_HEREDOC_PATTERN);
	if (!match?.[4]) {
		return undefined;
	}
	return { script: match[4] };
}

function extractPythonInlineFromTokens(tokens: string[]): string | undefined {
	const name = executableName(tokens[0] ?? "");
	if (!isPythonExecutable(name)) {
		return undefined;
	}
	for (let index = 1; index < tokens.length; index += 1) {
		const token = tokens[index] ?? "";
		if (token === "-m") {
			return undefined;
		}
		if (token === "-c") {
			return tokens[index + 1];
		}
		if (PYTHON_BARE_FLAGS.has(token)) {
			continue;
		}
		if (token.startsWith("-")) {
			continue;
		}
		return undefined;
	}
	return undefined;
}

function extractPythonPaths(script: string): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	const pattern = /['"]([^'"\n]+)['"]/g;
	let match = pattern.exec(script);
	while (match) {
		const value = match[1] ?? "";
		if (isLikelyPythonPath(value) && !seen.has(value)) {
			seen.add(value);
			paths.push(value);
		}
		match = pattern.exec(script);
	}
	return paths;
}

function isLikelyPythonPath(value: string): boolean {
	if (!value || value.length > MAX_EDIT_PATH_LENGTH || NON_PATH_STRINGS.has(value.toLowerCase())) {
		return false;
	}
	if (/[()={}]/.test(value) || value.includes(" ")) {
		return false;
	}
	return (
		value.includes("/") ||
		/^[A-Za-z]:[\\/]/.test(value) ||
		PATH_EXTENSION_PATTERN.test(value)
	);
}

function isPythonExecutable(name: string): boolean {
	return /^(python|python2|python3)(\.\d+)?$/.test(name);
}

function isSmallFormattingCommand(tokens: string[]): boolean {
	if (tokens.length === 0) {
		return false;
	}
	const cmd = executableName(tokens[0] ?? "");
	if (ALWAYS_FORMATTING.has(cmd)) {
		return true;
	}
	if (cmd === "xargs") {
		return !isMutatingXargs(tokens);
	}
	if (cmd === "awk") {
		return awkDataFile(tokens.slice(1)) === undefined;
	}
	if (cmd === "head" || cmd === "tail") {
		return fileOperandAfterCount(tokens.slice(1)) === undefined;
	}
	if (cmd === "sed") {
		const args = tokens.slice(1);
		return !sedHasInPlaceFlag(args) && sedReadPath(args) === undefined;
	}
	if (cmd === "nl") {
		return firstNonFlag(skipFlagValues(tokens.slice(1), ["-s", "-w", "-v", "-i", "-b"])) === undefined;
	}
	return false;
}

function isMutatingXargs(tokens: string[]): boolean {
	let index = 1;
	while (index < tokens.length) {
		const token = tokens[index] ?? "";
		if (token === "--") {
			return isMutatingSubcommand(tokens.slice(index + 1));
		}
		if (!token.startsWith("-")) {
			return isMutatingSubcommand(tokens.slice(index));
		}
		if (token.length === 2 && ["-E", "-e", "-I", "-L", "-n", "-P", "-s"].includes(token)) {
			index += 2;
			continue;
		}
		index += 1;
	}
	return false;
}

function isMutatingSubcommand(tokens: string[]): boolean {
	const head = tokens[0];
	const tail = tokens.slice(1);
	if (head === "perl" || head === "ruby") {
		return tail.some((token) => token === "-i" || token.startsWith("-i") || token === "-pi" || token.startsWith("-pi"));
	}
	if (head === "sed") {
		return sedHasInPlaceFlag(tail);
	}
	if (head === "rg") {
		return tail.includes("--replace");
	}
	return false;
}

function sedHasInPlaceFlag(args: string[]): boolean {
	for (const arg of args) {
		if (arg === "--") {
			break;
		}
		if (arg === "--in-place" || arg.startsWith("--in-place=")) {
			return true;
		}
		if (arg.startsWith("--")) {
			continue;
		}
		if (arg.startsWith("-") && arg.includes("i")) {
			return true;
		}
	}
	return false;
}

function sedReadPath(args: string[]): string | undefined {
	const trimmed = trimAtConnector(args);
	if (sedHasInPlaceFlag(trimmed) || !trimmed.includes("-n")) {
		return undefined;
	}
	let hasRange = false;
	for (let index = 0; index < trimmed.length; index += 1) {
		const arg = trimmed[index];
		if (arg === "-e" || arg === "--expression") {
			if (isValidSedRange(trimmed[index + 1])) {
				hasRange = true;
			}
			index += 1;
			continue;
		}
		if (!arg?.startsWith("-") && isValidSedRange(arg)) {
			hasRange = true;
		}
	}
	if (!hasRange) {
		return undefined;
	}
	const operands = positionalOperands(trimmed, ["-e", "-f", "--expression", "--file"]).filter(
		(arg) => !isValidSedRange(arg),
	);
	return operands[0];
}

function isValidSedRange(arg: string | undefined): boolean {
	if (!arg?.endsWith("p")) {
		return false;
	}
	const core = arg.slice(0, -1);
	const parts = core.split(",");
	return parts.length >= 1 && parts.length <= 2 && parts.every((part) => part.length > 0 && /^\d+$/.test(part));
}

function awkDataFile(args: string[]): string | undefined {
	const trimmed = trimAtConnector(args);
	const hasScriptFile = trimmed.includes("-f") || trimmed.includes("--file");
	const nonFlags = skipFlagValues(trimmed, ["-F", "-v", "-f", "--field-separator", "--assign", "--file"]).filter(
		(arg) => !arg.startsWith("-"),
	);
	if (hasScriptFile) {
		return nonFlags[0];
	}
	if (nonFlags.length >= 2) {
		return nonFlags[1];
	}
	return undefined;
}

function fileOperandAfterCount(args: string[]): string | undefined {
	if (args.length === 0) {
		return undefined;
	}
	if (args.length === 1 && !args[0]?.startsWith("-")) {
		return args[0];
	}
	const operands: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "-n" || arg === "-c") {
			index += 1;
			continue;
		}
		if (/^-n\+?\d+$/.test(arg) || /^-c\+?\d+$/.test(arg)) {
			continue;
		}
		if (!arg.startsWith("-")) {
			operands.push(arg);
		}
	}
	return operands[0];
}

function firstOperand(args: string[], flagsWithVals: string[]): string | undefined {
	const operand = positionalOperands(trimAtConnector(args), flagsWithVals)[0];
	return operand ? shortDisplayPath(operand) : undefined;
}

function singleOperand(args: string[], flagsWithVals: string[]): string | undefined {
	const operands = positionalOperands(trimAtConnector(args), flagsWithVals);
	return operands.length === 1 ? operands[0] : undefined;
}

function positionalOperands(args: string[], flagsWithVals: string[]): string[] {
	const out: string[] = [];
	let afterDoubleDash = false;
	let skipNext = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (afterDoubleDash) {
			out.push(arg);
			continue;
		}
		if (arg === "--") {
			afterDoubleDash = true;
			continue;
		}
		if (arg.startsWith("--") && arg.includes("=")) {
			continue;
		}
		if (flagsWithVals.includes(arg)) {
			skipNext = true;
			continue;
		}
		if (arg.startsWith("-")) {
			continue;
		}
		out.push(arg);
	}
	return out;
}

function skipFlagValues(args: string[], flagsWithVals: string[]): string[] {
	return positionalOperands(args, flagsWithVals);
}

function firstNonFlag(args: string[]): string | undefined {
	return args.find((arg) => !arg.startsWith("-"));
}

function trimAtConnector(args: string[]): string[] {
	const index = args.findIndex((token) => token === "|" || token === "&&" || token === "||" || token === ";");
	return index === -1 ? args : args.slice(0, index);
}

function cdTarget(args: string[]): string | undefined {
	let target: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "--") {
			return args[index + 1];
		}
		if (arg.startsWith("-")) {
			continue;
		}
		target = arg;
	}
	return target;
}

function executableName(token: string): string {
	const normalized = token.replace(/\\/g, "/");
	return normalized.split("/").pop() || normalized;
}

function shortDisplayPath(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const trimmed = normalized.replace(/\/+$/, "");
	const parts = trimmed.split("/").filter(
		(part) => part.length > 0 && part !== "build" && part !== "dist" && part !== "node_modules" && part !== "src",
	);
	return parts.at(-1) ?? trimmed;
}

function isPathish(value: string): boolean {
	return (
		value === "." ||
		value === ".." ||
		value.startsWith("./") ||
		value.startsWith("../") ||
		value.includes("/") ||
		value.includes("\\")
	);
}

function isAbsLike(path: string): boolean {
	return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function joinPaths(base: string, rel: string): string {
	if (isAbsLike(rel)) {
		return rel;
	}
	if (!base) {
		return rel;
	}
	return `${base.replace(/[/\\]+$/, "")}/${rel.replace(/^[/\\]+/, "")}`;
}

function shlexJoin(tokens: string[]): string {
	return tokens
		.map((token) => {
			if (token.length === 0) {
				return "''";
			}
			if (/^[A-Za-z0-9_./:=@-]+$/.test(token)) {
				return token;
			}
			return `'${token.replace(/'/g, `'\\''`)}'`;
		})
		.join(" ");
}

export function tokenize(input: string): string[] | null {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let index = 0;

	const pushCurrent = (): void => {
		if (current.length > 0 || quote !== null) {
			tokens.push(current);
			current = "";
		}
	};

	while (index < input.length) {
		const char = input[index] ?? "";
		if (quote === "'") {
			if (char === "'") {
				quote = null;
			} else {
				current += char;
			}
			index += 1;
			continue;
		}
		if (quote === '"') {
			if (char === "\\") {
				const next = input[index + 1];
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					current += next;
					index += 2;
					continue;
				}
				if (next === "\n") {
					index += 2;
					continue;
				}
			}
			if (char === '"') {
				quote = null;
				index += 1;
				continue;
			}
			current += char;
			index += 1;
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			index += 1;
			continue;
		}
		if (char === "\\" && index + 1 < input.length) {
			current += input[index + 1];
			index += 2;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			index += 1;
			continue;
		}

		const three = input.slice(index, index + 3);
		if (three === "2>>") {
			pushCurrent();
			tokens.push(three);
			index += 3;
			continue;
		}
		const two = input.slice(index, index + 2);
		if (two === "||" || two === "&&" || two === ">>" || two === "2>" || two === "&>") {
			pushCurrent();
			tokens.push(two);
			index += 2;
			continue;
		}
		if (char === "|" || char === ";" || char === ">" || char === "<") {
			pushCurrent();
			tokens.push(char);
			index += 1;
			continue;
		}

		current += char;
		index += 1;
	}

	if (quote) {
		return null;
	}
	if (current) {
		tokens.push(current);
	}
	return tokens;
}
