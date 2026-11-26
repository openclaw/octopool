import { htmlElements, parseHTMLDocument, repositoryAppData } from "./github-html-document";
import { isRecord } from "./object";
import { decodeURIComponentSafe } from "./github-path";
import { decodeHTML, htmlAttribute, textMatch } from "./github-html-utils";

type WorkflowPage =
  | { kind: "complete"; workflows: Record<string, unknown>[] }
  | { kind: "legacy"; workflows: Record<string, unknown>[]; pageCount: number };

export function parseWorkflowPageHTML(
  html: string,
  owner: string,
  repo: string,
): WorkflowPage | undefined {
  const document = parseHTMLDocument(html);
  if (document === undefined) return undefined;
  const app = repositoryAppData(htmlElements(document));
  if (app.kind === "invalid") return undefined;
  if (app.kind === "absent") {
    const workflows = parseWorkflowListHTML(html, owner, repo);
    const pageCount = parseWorkflowPageCount(html);
    return workflows === undefined || pageCount === undefined
      ? undefined
      : { kind: "legacy", workflows, pageCount };
  }
  if (app.path !== `/${owner}/${repo}/actions`) return undefined;
  const route = app.payload.workflowsLayoutRoute;
  if (
    !isRecord(route) ||
    !Number.isSafeInteger(route.totalCount) ||
    (route.totalCount as number) < 0 ||
    !Array.isArray(route.workflows) ||
    route.workflows.length !== route.totalCount
  )
    return undefined;
  const workflows: Record<string, unknown>[] = [];
  const ids = new Set<number>();
  for (const row of route.workflows) {
    if (
      !isRecord(row) ||
      !Number.isSafeInteger(row.id) ||
      (row.id as number) <= 0 ||
      ids.has(row.id as number) ||
      typeof row.name !== "string" ||
      typeof row.path !== "string" ||
      !/^(?:\.github\/workflows\/[^/?#]+\.ya?ml|dynamic\/[^?#]+)$/i.test(row.path) ||
      (row.state !== "active" && row.state !== "disabled_manually")
    )
      return undefined;
    ids.add(row.id as number);
    workflows.push({ id: row.id, name: row.name, path: row.path, state: row.state });
  }
  return { kind: "complete", workflows };
}

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
    const rawID = htmlAttribute(match[1]!, "data-item-id");
    if (rawID === undefined || !/^[1-9][0-9]*$/.test(rawID)) {
      return undefined;
    }
    const id = Number(rawID);
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

function parseWorkflowPageCount(html: string): number | undefined {
  const value = /data-total-pages="([0-9]+)"/.exec(html)?.[1];
  if (value === undefined) {
    return undefined;
  }
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 1 ? count : undefined;
}
