import type { RouteParameter } from "../../src/route-manifest";

const routeParameterExamples: Record<RouteParameter, string> = {
  owner: "openclaw",
  repo: "octopool",
  org: "openclaw",
  login: "octocat",
  number: "42",
  sha: "0123456789abcdef0123456789abcdef01234567",
  commitRef: "main",
  id: "42",
  attempt: "2",
  tag: "v1.2.3",
  gistId: "abc123",
  slug: "mit",
  template: "Go",
  compare: "main...feature",
  contentPath: "src/index.ts",
  readmeDir: "docs",
  label: "bug",
  branch: "main",
  gitRef: "heads/main",
  workflow: "ci.yml",
};

export function routeExample(template: string): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_token, rawName: string) => {
    const example = routeParameterExamples[rawName as RouteParameter];
    if (example === undefined) {
      throw new Error(`Unknown route parameter: ${rawName}`);
    }
    return example;
  });
}
