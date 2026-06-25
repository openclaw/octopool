import { decodeURIComponentSafe } from "./github-path";
import { decodeHTML, htmlAttribute, textMatch } from "./github-html-utils";

export function parseWorkflowListHTML(
  html: string,
  owner: string,
  repo: string,
): Record<string, unknown>[] | undefined {
  const expectedPrefix = `/${owner}/${repo}/actions/workflows/`;
  const items: Record<string, unknown>[] = [];
  for (const match of html.matchAll(
    /<li\b([^>]*data-test-selector="workflow-rendered"[^>]*)>([\s\S]*?)<\/li>/g,
  )) {
    const id = Number(htmlAttribute(match[1]!, "data-item-id"));
    const body = match[2]!;
    const href = /<a\b[^>]*href="([^"]+)"/.exec(body)?.[1];
    const name = textMatch(body, /<tool-tip\b[^>]*>([\s\S]*?)<\/tool-tip>/);
    if (!Number.isSafeInteger(id) || href === undefined || name === undefined) {
      return undefined;
    }
    const decodedHref = decodeHTML(href);
    if (!decodedHref.startsWith(expectedPrefix)) {
      return undefined;
    }
    const workflowRef = decodeURIComponentSafe(decodedHref.slice(expectedPrefix.length));
    if (workflowRef === "" || workflowRef.includes("?") || workflowRef.includes("#")) {
      return undefined;
    }
    const path = /\.ya?ml$/i.test(workflowRef)
      ? `.github/workflows/${workflowRef}`
      : `dynamic/${workflowRef}`;
    const disabled =
      /<span\b[^>]*class="[^"]*\bcolor-fg-muted\b[^"]*\btext-small\b[^"]*"[^>]*>\s*Disabled\s*<\/span>/i.test(
        body,
      );
    items.push({ id, name, path, state: disabled ? "disabled_manually" : "active" });
  }
  return items.length === 0 ? undefined : items;
}

export function parseWorkflowPageCount(html: string): number | undefined {
  const value = /data-total-pages="([0-9]+)"/.exec(html)?.[1];
  if (value === undefined) {
    return undefined;
  }
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 1 ? count : undefined;
}
