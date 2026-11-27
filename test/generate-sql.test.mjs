import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { queries } from "../src/generated/sql.ts";

const generator = fileURLToPath(new URL("../scripts/generate-sql.mjs", import.meta.url));

async function fixture(t, files) {
  const directory = await mkdtemp(path.join(tmpdir(), "octopool-sql-generator-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "sql/queries"), { recursive: true });
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(path.join(directory, "sql/queries", name), sql);
  }
  return directory;
}

function generate(directory) {
  execFileSync(process.execPath, [generator], { cwd: directory, stdio: "pipe" });
  return import(pathToFileURL(path.join(directory, "src/generated/sql.ts")).href);
}

for (const newline of ["\n", "\r\n"]) {
  test(`preserves annotation-like text inside SQL tokens with ${JSON.stringify(newline)}`, async (t) => {
    const statements = [
      ["SingleQuoted", "SELECT 'first'' quote\n-- name: Embedded :one\nlast' AS value"],
      ["DoubleQuoted", 'SELECT 1 AS "first"" quote\n-- name: Embedded :one\nlast"'],
      ["BacktickQuoted", "SELECT 1 AS `first`` quote\n-- name: Embedded :one\nlast`"],
      ["BracketQuoted", "SELECT 1 AS [first\n-- name: Embedded :one\nlast]"],
      ["Commented", "SELECT /*\n-- name: Embedded :one\n*/ 1 AS value"],
      ["AfterLineComment", "-- a quote ' in an ordinary comment\nSELECT 2 AS value"],
    ];
    const sql = statements
      .map(([name, statement]) => `-- name: ${name} :one\n${statement};\n`)
      .join("\n")
      .replaceAll("\n", newline);
    const directory = await fixture(t, { "queries.sql": sql });
    const generated = await generate(directory);
    assert.deepEqual(generated.queries, {
      singleQuoted: statements[0][1].replaceAll("\n", newline),
      doubleQuoted: statements[1][1].replaceAll("\n", newline),
      backtickQuoted: statements[2][1].replaceAll("\n", newline),
      bracketQuoted: statements[3][1].replaceAll("\n", newline),
      commented: statements[4][1].replaceAll("\n", newline),
      afterLineComment: statements[5][1].replaceAll("\n", newline),
    });
  });
}

test("sorts query files and keeps query order within each file", async (t) => {
  const directory = await fixture(t, {
    "z.sql": "-- name: Last :one\nSELECT 3;\n",
    "a.sql": "-- name: First :one\nSELECT 1;\n-- name: Second :one\nSELECT 2;\n",
    "ignored.txt": "not SQL",
  });
  assert.deepEqual(Object.entries((await generate(directory)).queries), [
    ["first", "SELECT 1"],
    ["second", "SELECT 2"],
    ["last", "SELECT 3"],
  ]);
});

test("rejects query names that collide after lowercasing the first letter", async (t) => {
  const directory = await fixture(t, {
    "a.sql": "-- name: Same :one\nSELECT 1;\n",
    "b.sql": "-- name: same :one\nSELECT 2;\n",
  });
  assert.throws(() => generate(directory), /duplicate query name: same/);
});

for (const preamble of ["-- ordinary preamble\n", "/*\n-- name: Fake :one\n*/\n"]) {
  test(`rejects an unannotated preamble ${JSON.stringify(preamble)}`, async (t) => {
    const directory = await fixture(t, {
      "queries.sql": `${preamble}-- name: Real :one\nSELECT 1;\n`,
    });
    assert.throws(() => generate(directory), /SQL block is missing a sqlc name annotation/);
  });
}

test("preserves every current generated query", async (t) => {
  const source = new URL("../sql/queries/", import.meta.url);
  const files = {};
  for (const name of await readdir(source)) {
    if (name.endsWith(".sql")) files[name] = await readFile(new URL(name, source), "utf8");
  }
  const directory = await fixture(t, files);
  assert.deepEqual((await generate(directory)).queries, queries);
});
