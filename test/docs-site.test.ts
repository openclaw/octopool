import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("docs site generator", () => {
  it("keeps wrapped markdown list items in one list item", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "octopool-docs-"));
    try {
      mkdirSync(path.join(tmp, "docs", "assets"), { recursive: true });
      writeFileSync(path.join(tmp, "docs", "CNAME"), "docs.example.test\n");
      for (const name of ["favicon-32.png", "favicon.ico", "apple-touch-icon.png"]) {
        writeFileSync(path.join(tmp, "docs", "assets", name), "");
      }
      writeFileSync(path.join(tmp, "docs", "cli.md"), "# CLI\n");
      writeFileSync(
        path.join(tmp, "docs", "index.md"),
        [
          "# Fixture",
          "",
          "- [CLI](cli.md) — first",
          "  wrapped line with `code`.",
          "- Second & third",
          "  continuation.",
          "",
        ].join("\n"),
      );
      execFileSync("node", [path.join(root, "scripts/build-docs-site.mjs")], {
        cwd: tmp,
        stdio: "pipe",
      });
      const index = readFileSync(path.join(tmp, "dist/docs-site/index.html"), "utf8");
      expect(index).toContain(
        [
          "<ul>",
          '<li><a href="cli.html">CLI</a> — first wrapped line with <code>code</code>.</li>',
          "<li>Second &amp; third continuation.</li>",
          "</ul>",
        ].join("\n"),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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
      writeFileSync(
        path.join(tmp, "docs", "cli.md"),
        ["# CLI", "", "## First *section*", "", "## Second `section` <script", ""].join("\n"),
      );

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
      const cli = readFileSync(path.join(tmp, "dist/docs-site/cli.html"), "utf8");
      expect(cli).toContain('class="toc-l2" href="#first-section">First section</a>');
      expect(cli).toContain(
        'class="toc-l2" href="#second-section-script">Second section &amp;lt;script</a>',
      );
      expect(cli).not.toContain("<script</a>");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
