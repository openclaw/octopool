import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { applyD1Migrations } from "cloudflare:test";

export type D1Baseline = readonly string[];

type SchemaObject = { name: string; type: string; sql: string | null };
const internal = (name: string) => name.startsWith("_cf_") || name.startsWith("sqlite_");
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function applicationSchema(db: D1Database): Promise<SchemaObject[]> {
  const { results } = await db
    .prepare("SELECT name, type, sql FROM sqlite_schema ORDER BY rowid")
    .all<SchemaObject>();
  if (results.some(({ name }) => name.startsWith("sqlite_stat"))) {
    throw new Error("D1 baseline does not support SQLite statistics tables");
  }
  const schema = results.filter(({ name }) => !internal(name));
  if (schema.some(({ sql }) => /^CREATE\s+VIRTUAL\s+TABLE\b/i.test(sql ?? ""))) {
    throw new Error("D1 baseline does not support virtual tables");
  }
  return schema;
}

export async function initializeD1Baseline(
  db: D1Database,
  migrations: D1Migration[],
): Promise<D1Baseline> {
  if ((await applicationSchema(db)).length !== 0) {
    throw new Error("D1 baseline initialization requires a pristine database");
  }
  await applyD1Migrations(db, migrations);
  return captureD1Baseline(db);
}

// Miniflare 5.20260804.0-alpha dumpSql(), also used by Wrangler 4.120.1.
// The exact pragma accepts two numeric flags and no table filter. Its single
// result row contains COMPLETE statements, including multiline CREATE/INSERTs.
// This is a test-runtime contract, not a production D1 API or D1.exec() dump.
export async function captureD1Baseline(db: D1Database): Promise<D1Baseline> {
  await applicationSchema(db);
  const rows: unknown = await db.prepare("PRAGMA miniflare_d1_export(?,?,?);").bind(0, 0).raw();
  return validateD1Export(rows);
}

export function validateD1Export(rows: unknown): D1Baseline {
  if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0])) {
    throw new Error("Unsupported Miniflare D1 export: expected one statement array");
  }
  const statements: unknown[] = Array.from(rows[0]);
  if (
    statements[0] !== "PRAGMA defer_foreign_keys=TRUE;" ||
    statements.some(
      (sql, index) =>
        typeof sql !== "string" ||
        !sql.endsWith(";") ||
        (index > 0 &&
          !/^(?:CREATE (?:TABLE|INDEX|UNIQUE INDEX|TRIGGER|VIEW)\b|INSERT INTO\b|DELETE FROM sqlite_sequence;)/i.test(
            sql,
          )),
    )
  ) {
    throw new Error("Unsupported Miniflare D1 export statement contract");
  }
  return Object.freeze(statements.slice() as string[]);
}

export function childFirstTables(tables: ReadonlyMap<string, readonly string[]>): string[] {
  // SQLite folds ASCII identifiers, including quoted FK target names.
  const fold = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const names = new Map([...tables.keys()].map((name) => [fold(name), name]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const parentsFirst: string[] = [];
  function visit(table: string): void {
    if (visiting.has(table)) {
      throw new Error(`D1 baseline does not support foreign-key cycles: ${table}`);
    }
    if (visited.has(table)) return;
    visiting.add(table);
    for (const parent of tables.get(table) ?? []) {
      const actual = names.get(fold(parent));
      if (actual !== undefined) visit(actual);
    }
    visiting.delete(table);
    visited.add(table);
    parentsFirst.push(table);
  }
  for (const table of tables.keys()) visit(table);
  return parentsFirst.reverse();
}

export async function restoreD1Baseline(db: D1Database, baseline: D1Baseline): Promise<void> {
  const schema = await applicationSchema(db);
  const tables = schema.filter(({ type }) => type === "table");
  const dependencies = tables.length
    ? await db.batch<{ table: string }>(
        tables.map(({ name }) => db.prepare(`PRAGMA foreign_key_list(${identifier(name)})`)),
      )
    : [];
  const ordered = childFirstTables(
    new Map(
      tables.map(({ name }, index) => [name, dependencies[index]!.results.map((row) => row.table)]),
    ),
  );
  const teardown = [
    ...schema
      .filter(({ type }) => type === "trigger" || type === "view")
      .map(({ type, name }) => `DROP ${type.toUpperCase()} ${identifier(name)}`),
    ...ordered.map((name) => `DROP TABLE ${identifier(name)}`),
  ];
  // DROP TABLE also removes its indexes. The export restores sqlite_sequence
  // after recreating AUTOINCREMENT tables. All destruction/replay rolls back
  // together on failure; foreign_keys stays enabled throughout.
  await db.batch([...teardown, ...baseline].map((sql) => db.prepare(sql)));
}
