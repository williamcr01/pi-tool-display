import assert from "node:assert/strict";
import test from "node:test";
import {
	getChangedEditFiles,
	getSingleEditCommand,
	isExploringCommands,
	parseCommand,
} from "../src/parse-command.ts";

function typesOf(command: string): string[] {
	return parseCommand(command).map((item) => item.type);
}

test("parseCommand classifies file readers as read", () => {
	const parsed = parseCommand("cat webview/README.md");
	assert.deepEqual(parsed, [
		{ type: "read", cmd: "cat webview/README.md", name: "README.md", path: "webview/README.md" },
	]);
	assert.equal(parseCommand("bat --theme TwoDark README.md")[0]?.type, "read");
	assert.equal(parseCommand("head -n 50 Cargo.toml")[0]?.type, "read");
	assert.equal(parseCommand("head -n50 Cargo.toml")[0]?.type, "read");
	assert.equal(parseCommand("tail -n +10 README.md")[0]?.type, "read");
	assert.equal(parseCommand("sed -n '1,80p' src/index.ts")[0]?.type, "read");
	assert.equal(parseCommand("nl -ba core/src/parse_command.rs")[0]?.type, "read");
});

test("parseCommand joins cd with a following read", () => {
	const parsed = parseCommand("cd foo && cat foo.txt");
	assert.deepEqual(parsed, [{ type: "read", cmd: "cat foo.txt", name: "foo.txt", path: "foo/foo.txt" }]);
});

test("parseCommand classifies list and search commands", () => {
	assert.equal(parseCommand("ls -la src")[0]?.type, "list");
	assert.equal(parseCommand("rg --files webview/src")[0]?.type, "list");
	assert.equal(parseCommand("git ls-files src")[0]?.type, "list");
	assert.equal(parseCommand("find src -type f")[0]?.type, "list");

	const search = parseCommand('rg -n "TODO" src');
	assert.deepEqual(search[0], {
		type: "search",
		cmd: "rg -n TODO src",
		query: "TODO",
		path: "src",
	});
	assert.equal(parseCommand("git grep TODO src")[0]?.type, "search");
	assert.equal(parseCommand("find . -name '*.rs'")[0]?.type, "search");
	assert.equal(parseCommand("fd main src")[0]?.type, "search");
});

test("parseCommand drops formatting pipeline stages", () => {
	assert.equal(parseCommand("rg --files | head -n 50")[0]?.type, "list");
	assert.equal(parseCommand("ls -la | sed -n '1,120p'")[0]?.type, "list");
	assert.equal(parseCommand("yes | rg --files")[0]?.type, "list");
	assert.equal(parseCommand("true && rg --files")[0]?.type, "list");
});

test("parseCommand keeps unknown and mutating commands raw", () => {
	assert.deepEqual(typesOf("npm run build"), ["unknown"]);
	assert.deepEqual(typesOf("git status"), ["unknown"]);
	assert.deepEqual(typesOf("echo foo > bar"), ["unknown"]);
	assert.deepEqual(typesOf("sed -i 's/a/b/' file.txt"), ["unknown"]);
	assert.deepEqual(
		typesOf("rg -l QkBindingController src | xargs perl -pi -e 's/foo/bar/g'"),
		["unknown"],
	);
});

test("parseCommand treats unclosed quotes as unknown", () => {
	assert.deepEqual(typesOf("cat 'unterminated"), ["unknown"]);
});

test("parseCommand unwraps bash -lc scripts", () => {
	assert.equal(parseCommand("bash -lc 'cat README.md'")[0]?.type, "read");
	assert.equal(parseCommand("/bin/bash -lc 'rg --files'")[0]?.type, "list");
});

test("parseCommand classifies python file walks as list and prints as unknown", () => {
	assert.equal(parseCommand(`python3 -c "import os; print(os.listdir('.'))"`)[0]?.type, "list");
	assert.equal(parseCommand(`python3 -c "print('hello')"`)[0]?.type, "unknown");
	assert.equal(parseCommand("python3 -m pytest")[0]?.type, "unknown");
	assert.equal(parseCommand("python3 script.py")[0]?.type, "unknown");
});

test("parseCommand classifies inline python writes as edit", () => {
	const inline = parseCommand(`python3 -c "from pathlib import Path; Path('src/foo.ts').write_text('x')"`);
	assert.deepEqual(inline, [
		{
			type: "edit",
			cmd: `python3 -c "from pathlib import Path; Path('src/foo.ts').write_text('x')"`,
			paths: ["src/foo.ts"],
		},
	]);

	const heredoc = parseCommand(
		`python3 <<'PY'\nfrom pathlib import Path\nPath("src/foo.ts").write_text("hello")\nPY`,
	);
	assert.equal(heredoc[0]?.type, "edit");
	assert.deepEqual(heredoc[0]?.type === "edit" ? heredoc[0].paths : [], ["src/foo.ts"]);
});

test("parseCommand does not treat python string escapes as extra edit paths", () => {
	const parsed = parseCommand(`python3 -c "from pathlib import Path; Path('note.txt').write_text('after\\n')"`);
	assert.deepEqual(parsed[0]?.type === "edit" ? parsed[0].paths : [], ["note.txt"]);
});

test("parseCommand does not treat python subprocess scripts as edits", () => {
	assert.equal(
		parseCommand(`python3 -c "import subprocess; subprocess.run(['rm', 'src/foo.ts'])"`)[0]?.type,
		"unknown",
	);
});

test("exploring and edit helpers distinguish command kinds", () => {
	assert.equal(isExploringCommands(parseCommand("cat README.md")), true);
	assert.equal(isExploringCommands(parseCommand("npm test")), false);
	assert.ok(getSingleEditCommand(parseCommand(`python3 -c "Path('a.ts').write_text('x')"`)));
	assert.equal(getSingleEditCommand(parseCommand("cat README.md")), undefined);
});

test("getChangedEditFiles requires a content change", () => {
	assert.deepEqual(
		getChangedEditFiles([
			{ path: "a.ts", fileExistedBeforeWrite: true, previousContent: "old", nextContent: "old" },
			{ path: "b.ts", fileExistedBeforeWrite: false, nextContent: "new" },
			{ path: "c.ts", fileExistedBeforeWrite: true, previousContent: "old", nextContent: "new" },
		]).map((file) => file.path),
		["b.ts", "c.ts"],
	);
});
