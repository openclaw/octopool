import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("docs site generator", () => {
  it("keeps wrapped markdown list items in one list item", () => {
    execFileSync("node", ["scripts/build-docs-site.mjs"], { cwd: root, stdio: "pipe" });

    const index = readFileSync(path.join(root, "dist/docs-site/index.html"), "utf8");
    expect(index).toContain(
      '<li><a href="relay.html">GitHub read relay</a> — the <code>POST /v1/github/request</code> endpoint, supported routes, response envelope, policy gates, and safety limits.</li>',
    );
    expect(index).toContain(
      '<li><a href="identities.html">Pooled identities &amp; routing</a> — PAT and GitHub App identities, scopes, and the pool coordinator&#39;s selection, leases, and cooldowns.</li>',
    );
    expect(index).not.toContain("</ul>\n<p>routes,");
    expect(index).not.toContain("</ul>\n<p>and the pool coordinator");
  });

  it("escapes frontmatter metadata in social meta attributes", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "octopool-docs-"));
    try {
      mkdirSync(path.join(tmp, "docs", "assets"), { recursive: true });
      writeFileSync(path.join(tmp, "docs", "CNAME"), "docs.example.test\n");
      writeFileSync(path.join(tmp, "docs", "assets", "favicon-32.png"), "");
      writeFileSync(path.join(tmp, "docs", "assets", "favicon.ico"), "");
      writeFileSync(path.join(tmp, "docs", "assets", "apple-touch-icon.png"), "");
      writeFileSync(
        path.join(tmp, "docs", "index.md"),
        [
          "---",
          'title: Relay "Alpha"',
          'description: Shared <relay> "quotes"',
          "---",
          "# Fixture",
          "",
        ].join("\n"),
      );
      writeFileSync(path.join(tmp, "docs", "cli.md"), "# CLI\n");

      execFileSync("node", [path.join(root, "scripts/build-docs-site.mjs")], {
        cwd: tmp,
        stdio: "pipe",
      });

      const index = readFileSync(path.join(tmp, "dist/docs-site/index.html"), "utf8");
      expect(index).toContain(
        'property="og:description" content="Shared &lt;relay&gt; &quot;quotes&quot;"',
      );
      expect(index).toContain(
        'name="twitter:description" content="Shared &lt;relay&gt; &quot;quotes&quot;"',
      );
      expect(index).not.toContain('content="Shared <relay> "quotes""');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
