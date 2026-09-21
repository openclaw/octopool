import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { decodePathStrict } from "./github-public-utils";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const INERT = new Set(["script", "style", "template", "noscript"]);
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

export function parseReleaseMetadataHTML(
  html: string,
  owner: string,
  repo: string,
  responseURL: string,
  expectedTag?: string,
): Record<string, unknown> | undefined {
  const url = new URL(responseURL);
  const prefix = `/${owner}/${repo}/releases/tag/`;
  if (
    url.origin !== "https://github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.startsWith(prefix)
  )
    return undefined;
  const tag = decodePathStrict(url.pathname.slice(prefix.length));
  if (tag === undefined || tag === "" || (expectedTag !== undefined && tag !== expectedTag))
    return undefined;

  const document = parse(html, { sourceCodeLocationInfo: true });
  const all = elements(document);
  if (
    !["html", "body"].every((name) =>
      all.some(
        (element) => element.tagName === name && element.sourceCodeLocation?.endTag !== undefined,
      ),
    )
  )
    return undefined;
  const publicMarkers = all.filter(
    (element) =>
      element.tagName === "meta" &&
      attribute(element, "name") === "octolytics-dimension-repository_public",
  );
  if (publicMarkers.length !== 1 || attribute(publicMarkers[0], "content") !== "true")
    return undefined;
  const cards = all.filter(
    (element) =>
      hasClasses(element, "Box-body") &&
      children(element).some((child) => hasClasses(child, "d-flex", "flex-md-row", "flex-column")),
  );
  if (cards.length !== 1) return undefined;
  const card = cards[0]!;
  const header = children(card).filter((element) =>
    hasClasses(element, "d-flex", "flex-md-row", "flex-column"),
  );
  const publication = children(card).filter((element) =>
    hasClasses(element, "tmp-mb-3", "tmp-pb-md-4", "border-md-bottom"),
  );
  if (
    header.length !== 1 ||
    publication.length !== 1 ||
    !completeElement(header[0]!) ||
    !completeRegion(publication[0]!) ||
    card.sourceCodeLocation?.endTag === undefined
  )
    return undefined;
  const metadata = children(header[0]!).filter((element) =>
    hasClasses(element, "d-flex", "flex-row", "flex-1", "wb-break-word"),
  );
  if (metadata.length !== 1 || !completeRegion(metadata[0]!)) return undefined;
  const headerElements = elements(metadata[0]!);
  const titles = headerElements.filter(
    (element) => element.tagName === "h1" && hasClasses(element, "d-inline"),
  );
  if (
    titles.length !== 1 ||
    text(titles[0]!).trim() === "" ||
    header[0]!.sourceCodeLocation!.endOffset > publication[0]!.sourceCodeLocation!.startOffset
  )
    return undefined;

  const breadcrumbs = all.filter((element) => {
    if (element.tagName !== "a") return false;
    const item = element.parentNode;
    if (item === null || !("tagName" in item) || !hasClasses(item, "breadcrumb-item-selected"))
      return false;
    const list = item.parentNode;
    if (list === null || !("tagName" in list) || list.tagName !== "ol") return false;
    const nav = list.parentNode;
    return (
      nav !== null &&
      "tagName" in nav &&
      nav.tagName === "nav" &&
      attribute(nav, "aria-label") === "Breadcrumb" &&
      completeRegion(nav) &&
      nav.sourceCodeLocation!.endOffset <= card.sourceCodeLocation!.startOffset
    );
  });
  if (
    breadcrumbs.length !== 1 ||
    attribute(breadcrumbs[0], "href") !== url.pathname ||
    text(breadcrumbs[0]!).trim() !== tag
  )
    return undefined;

  const labels = new Set(
    headerElements
      .filter((element) => hasClasses(element, "Label", "Label--large"))
      .map((element) => text(element).trim()),
  );
  if (
    [...labels].some((label) => label !== "Latest" && label !== "Pre-release") ||
    labels.size > 1 ||
    (expectedTag === undefined && !labels.has("Latest"))
  )
    return undefined;
  const timestamps = elements(publication[0]!).filter(
    (element) => element.tagName === "relative-time" && hasClasses(element, "no-wrap"),
  );
  const timestamp = timestamps[0];
  const publishedAt = attribute(timestamp, "datetime");
  const row = timestamp?.parentNode;
  if (
    timestamps.length !== 1 ||
    publishedAt === undefined ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(publishedAt) ||
    !Number.isFinite(Date.parse(publishedAt)) ||
    row === null ||
    row === undefined ||
    !/\breleased this\b/.test(text(row))
  )
    return undefined;
  return {
    tag_name: tag,
    html_url: url.href,
    draft: false,
    prerelease: labels.has("Pre-release"),
    published_at: publishedAt,
  };
}

function children(root: Element): Element[] {
  return root.childNodes.filter(
    (node): node is Element => "tagName" in node && node.namespaceURI === HTML_NAMESPACE,
  );
}

function elements(root: Node): Element[] {
  const result: Element[] = [];
  const pending = "childNodes" in root ? [...root.childNodes].reverse() : [];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (!("tagName" in node) || node.namespaceURI !== HTML_NAMESPACE || INERT.has(node.tagName))
      continue;
    result.push(node);
    pending.push(...[...node.childNodes].reverse());
  }
  return result;
}

function attribute(element: Element | undefined, name: string): string | undefined {
  return element?.attrs.find((item) => item.name === name && item.namespace === undefined)?.value;
}

function hasClasses(element: Element, ...names: string[]): boolean {
  const classes = (attribute(element, "class") ?? "").split(/\s+/);
  return names.every((name) => classes.includes(name));
}

function text(node: Node): string {
  if ("value" in node) return node.value;
  if (
    !("childNodes" in node) ||
    ("tagName" in node && (node.namespaceURI !== HTML_NAMESPACE || INERT.has(node.tagName)))
  )
    return "";
  return node.childNodes.map(text).join("");
}

function completeRegion(region: Element): boolean {
  // Inferred closing tags and reparented markup cannot prove a complete header.
  return [region, ...elements(region)].every(completeElement);
}

function completeElement(element: Element): boolean {
  const location = element.sourceCodeLocation;
  const parent = element.parentNode;
  const parentLocation =
    parent !== null && "tagName" in parent ? parent.sourceCodeLocation : undefined;
  return (
    location?.startTag !== undefined &&
    (VOID.has(element.tagName) || location.endTag !== undefined) &&
    parentLocation?.startTag !== undefined &&
    location.startOffset >= parentLocation.startTag.endOffset &&
    location.endOffset <= (parentLocation.endTag?.startOffset ?? parentLocation.endOffset)
  );
}
