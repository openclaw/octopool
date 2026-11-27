import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { isRecord } from "./object";

export type HTMLTreeElement = DefaultTreeAdapterTypes.Element;
export type HTMLTreeNode = DefaultTreeAdapterTypes.Node;

export const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const ambiguousAttributes = new WeakSet<HTMLTreeElement>();
const INERT_ELEMENTS = new Set([
  "script",
  "style",
  "template",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
]);

export function parseHTMLElements(html: string): HTMLTreeElement[] | undefined {
  let invalid = false;
  let missingDoctype = false;
  const duplicateOffsets: number[] = [];
  const document = parse(html, {
    scriptingEnabled: true,
    sourceCodeLocationInfo: true,
    onParseError(error) {
      if (error.code === "missing-doctype") missingDoctype = true;
      // GitHub emits duplicate attributes in unrelated dialog controls. Reject
      // duplicates on retained evidence below, not the entire document.
      else if (error.code === "duplicate-attribute") duplicateOffsets.push(error.startOffset);
      else invalid = true;
    },
  });
  const elements = htmlElements(document);
  for (const element of elements) {
    const tag = element.sourceCodeLocation?.startTag;
    if (
      tag !== undefined &&
      duplicateOffsets.some((offset) => offset >= tag.startOffset && offset < tag.endOffset)
    )
      ambiguousAttributes.add(element);
  }
  // Fragments have an implicit document scaffold; full documents must declare their mode.
  if (
    missingDoctype &&
    elements.some(
      (element) =>
        ["html", "head", "body"].includes(element.tagName) &&
        element.sourceCodeLocation !== null &&
        element.sourceCodeLocation !== undefined,
    )
  )
    invalid = true;
  // HTML accepts names such as `scr<!--x--` without a parse error. They are not
  // GitHub elements and cannot provide an ownership boundary, even as ancestors.
  if (
    elements.some(
      (element) =>
        element.namespaceURI === HTML_NAMESPACE && !/^[a-z][a-z0-9-]*$/.test(element.tagName),
    )
  )
    invalid = true;
  return invalid ? undefined : elements;
}

export function htmlElements(
  root: HTMLTreeNode | undefined,
  exclude?: (element: HTMLTreeElement) => boolean,
): HTMLTreeElement[] {
  const elements: HTMLTreeElement[] = [];
  const pending = root !== undefined && "childNodes" in root ? [...root.childNodes].reverse() : [];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (!("tagName" in node)) continue;
    if (exclude?.(node)) continue;
    elements.push(node);
    // Keep SVG status icons, but never traverse foreign or inert content for ownership.
    if (node.namespaceURI === HTML_NAMESPACE && !INERT_ELEMENTS.has(node.tagName)) {
      for (let index = node.childNodes.length - 1; index >= 0; index--)
        pending.push(node.childNodes[index]!);
    }
  }
  return elements;
}

export function htmlText(root: HTMLTreeNode | undefined): string {
  const parts: string[] = [];
  const pending = root === undefined ? [] : [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if ("value" in node) parts.push(node.value);
    else if (
      "childNodes" in node &&
      !(
        "tagName" in node &&
        (node.namespaceURI !== HTML_NAMESPACE || INERT_ELEMENTS.has(node.tagName))
      )
    ) {
      for (let index = node.childNodes.length - 1; index >= 0; index--)
        pending.push(node.childNodes[index]!);
    }
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

export function elementAttribute(
  element: HTMLTreeElement | undefined,
  name: string,
): string | undefined {
  return element?.attrs.find(
    (elementAttribute) =>
      elementAttribute.name === name && elementAttribute.namespace === undefined,
  )?.value;
}

export function onlyElement(elements: HTMLTreeElement[]): HTMLTreeElement | undefined {
  return elements.length === 1 ? elements[0] : undefined;
}

export function disjointRegions(regions: HTMLTreeElement[]): boolean {
  const ordered = [...regions].sort(
    (left, right) =>
      (left.sourceCodeLocation?.startOffset ?? 0) - (right.sourceCodeLocation?.startOffset ?? 0),
  );
  return ordered.every((region, index) => {
    const location = region.sourceCodeLocation;
    return (
      region.namespaceURI === HTML_NAMESPACE &&
      !ambiguousAttributes.has(region) &&
      location?.endTag !== undefined &&
      (index === 0 || ordered[index - 1]!.sourceCodeLocation!.endOffset <= location.startOffset)
    );
  });
}

export function ownedElements(
  region: HTMLTreeElement,
  exclude?: (element: HTMLTreeElement) => boolean,
): HTMLTreeElement[] | undefined {
  if (!disjointRegions([region])) return undefined;
  const elements = htmlElements(region, exclude);
  // parse5 can repair nesting without emitting an error. Do not use inferred closures
  // or reparented nodes inside an ownership region as evidence.
  for (const element of elements) {
    const location = element.sourceCodeLocation;
    const parent = element.parentNode;
    const parentLocation =
      parent !== null && "tagName" in parent ? parent.sourceCodeLocation : undefined;
    if (
      ambiguousAttributes.has(element) ||
      location === undefined ||
      location === null ||
      parentLocation?.startTag === undefined ||
      location.startOffset < parentLocation.startTag.endOffset ||
      location.endOffset > (parentLocation.endTag?.startOffset ?? parentLocation.endOffset) ||
      (element.childNodes.length > 0 &&
        element.namespaceURI === HTML_NAMESPACE &&
        location.endTag === undefined)
    )
      return undefined;
  }
  return elements;
}

type RepositoryAppData =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "present"; path: string; payload: Record<string, unknown> };

export function repositoryAppData(elements: HTMLTreeElement[]): RepositoryAppData {
  const apps = elements.filter(
    (element) =>
      element.tagName === "react-app" && elementAttribute(element, "app-name") === "repo",
  );
  if (apps.length === 0) return { kind: "absent" };
  const app = onlyElement(apps);
  const path = elementAttribute(app, "initial-path");
  if (app === undefined || !disjointRegions([app]) || path === undefined)
    return { kind: "invalid" };
  const scripts = app.childNodes.filter(
    (node): node is HTMLTreeElement =>
      "tagName" in node &&
      node.tagName === "script" &&
      elementAttribute(node, "data-target") === "react-app.embeddedData",
  );
  const script = onlyElement(scripts);
  if (
    script === undefined ||
    elementAttribute(script, "type") !== "application/json" ||
    !disjointRegions([script]) ||
    ownedElements(app, (element) => element !== script) === undefined ||
    script.childNodes.some((node) => !("value" in node))
  )
    return { kind: "invalid" };
  let data: unknown;
  try {
    data = JSON.parse(
      script.childNodes.map((node) => ("value" in node ? node.value : "")).join(""),
    );
  } catch {
    return { kind: "invalid" };
  }
  return isRecord(data) && isRecord(data.payload)
    ? { kind: "present", path, payload: data.payload }
    : { kind: "invalid" };
}
