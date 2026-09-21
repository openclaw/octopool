// Release-header structure from anonymous Octopool and TypeScript release pages;
// the comparison placeholder retains GitHub's implicitly closed paragraph markup.
export function releaseMetadataHTML(tag = "v0.6.9", badge = ""): string {
  const label = badge === "" ? "" : `<span class="Label Label--large">${badge}</span>`;
  return `<!DOCTYPE html><html><head>
<meta name="octolytics-dimension-repository_public" content="true">
</head><body>
<nav aria-label="Breadcrumb"><ol><li class="breadcrumb-item breadcrumb-item-selected"><a class="Link" href="/openclaw/octopool/releases/tag/${encodeURIComponent(tag)}">${tag}</a></li></ol></nav>
<div class="Box"><div class="Box-body">
  <div class="d-flex flex-md-row flex-column">
    <div class="d-flex flex-row flex-1 tmp-mb-3 wb-break-word"><div class="flex-1">
      <h1 class="tmp-mr-3 d-inline">Rendered release name</h1>${label}
    </div><div class="d-md-none">${label}</div></div>
    <div class="d-flex tmp-mb-3"><details><summary>Compare</summary>
      <div class="dropdown-menu"><p class="Banner-title"><h2 class="f6 text-normal">Sorry, something went wrong.</h2></p></div>
    </details></div>
  </div>
  <div class="tmp-mb-3 tmp-pb-md-4 border-md-bottom">
    <div class="d-flex flex-row flex-wrap color-fg-muted flex-items-end">
      <div class="tmp-mr-4 mb-2">fixture-author released this
        <relative-time class="no-wrap" datetime="2026-09-20T19:08:46Z">20 Sep 19:08</relative-time>
      </div>
    </div>
  </div>
  <div data-test-selector="body-content" class="markdown-body tmp-my-3">
    <h1>Pre-release Draft</h1><span class="Label Label--large">Pre-release</span>
    <relative-time datetime="2000-01-01T00:00:00Z">Unrelated note</relative-time>
  </div>
</div></div></body></html>`;
}
