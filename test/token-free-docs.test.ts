import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PUBLIC_SHAPES } from "../src/github-public-shapes";
import { ROUTES } from "../src/route-manifest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("token-free endpoint documentation", () => {
  it("matches every supported route kind", () => {
    const docs = readFileSync(path.join(root, "docs/relay.md"), "utf8");
    const documented = new Set(
      Array.from(
        section(docs, "supported-route-kinds").matchAll(/^- `([^`]+)`$/gm),
        (match) => match[1]!,
      ),
    );
    expect([...documented].sort()).toEqual([...new Set(ROUTES.map((route) => route.kind))].sort());
  });

  it("matches every implemented anonymous API route", () => {
    const docs = readFileSync(path.join(root, "docs/token-free.md"), "utf8");

    const documented = new Set(
      section(docs, "token-free-api-routes")
        .match(/^GET (\/\S+)$/gm)
        ?.map((line) => line.slice("GET ".length)) ?? [],
    );
    const implemented = new Set(
      ROUTES.filter(
        (route) => route.capabilities.publicApi || route.capabilities.fallback !== "pool",
      ).map((route) => normalizeRoute(route.template)),
    );

    expect([...documented].sort()).toEqual([...implemented].sort());
  });

  it("documents every no-API-quota transport family", () => {
    const docs = readFileSync(path.join(root, "docs/token-free.md"), "utf8");
    for (const source of [
      "patch-diff.githubusercontent.com",
      "raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}",
      "{repo}.git/info/refs?service=git-upload-pack",
      "/issues?q=is%3Aissue",
      "/actions/runs/{id}/job_groups_batch?attempt=1",
      "/actions/workflows_partial?query=&page={page}",
      "/releases/tag/{tag}",
    ]) {
      expect(docs).toContain(source);
    }
    for (const shape of Object.values(PUBLIC_SHAPES)) {
      expect(docs).toContain(shape);
    }
  });
});

function section(input: string, name: string): string {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const startIndex = input.indexOf(start);
  const endIndex = input.indexOf(end);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return input.slice(startIndex + start.length, endIndex);
}

function normalizeRoute(value: string): string {
  const names: Record<string, string> = {
    compare: "comparison",
    contentPath: "path",
    gistId: "gist",
    gitRef: "ref",
    readmeDir: "dir",
  };
  return value.replace(/\{([^}]+)\}/g, (_, name: string) => `{${names[name] ?? name}}`);
}
