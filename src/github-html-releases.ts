import { decodeURIComponentSafe } from "./github-path";
import { decodeHTML, stripHTMLTags, textMatch } from "./github-html-utils";

export function parseReleaseHTML(
  html: string,
  owner: string,
  repo: string,
  responseURL: string,
): Record<string, unknown> | undefined {
  const tag = releaseTag(responseURL);
  const name = textMatch(
    html,
    /breadcrumb-item-selected[\s\S]*?<\/nav>[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>/,
  );
  const publishedAt = /released this[\s\S]{0,800}?<relative-time[^>]*datetime="([^"]+)"/.exec(
    html,
  )?.[1];
  if (tag === undefined || name === undefined || publishedAt === undefined) {
    return undefined;
  }
  const bodyHTML =
    /data-test-selector="body-content"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<div[^>]*class="Box-footer"/.exec(
      html,
    )?.[1] ?? "";
  return {
    tag_name: tag,
    name,
    html_url: `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(tag)}`,
    draft: false,
    prerelease: />\s*Pre-release\s*</i.test(html),
    created_at: publishedAt,
    published_at: publishedAt,
    body: htmlToText(bodyHTML),
  };
}

function releaseTag(responseURL: string): string | undefined {
  try {
    const match = /\/releases\/tag\/(.+)$/.exec(new URL(responseURL).pathname);
    return match === null ? undefined : decodeURIComponentSafe(match[1]!);
  } catch {
    return undefined;
  }
}

function htmlToText(value: string): string {
  const formatted = value
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const label = stripHTMLTags(String(text)).trim();
      return label === "" ? "" : `[${label}](${decodeHTML(String(href))})`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/(?:p|h[1-6]|ul|ol)>/gi, "\n\n")
    .replace(/<code\b[^>]*>/gi, "`")
    .replace(/<\/code>/gi, "`");
  return decodeHTML(stripHTMLTags(formatted))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
