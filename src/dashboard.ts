const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#08080c">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%230b0b10'/%3E%3Ccircle cx='16' cy='13' r='6.5' fill='%23ff3355'/%3E%3Cpath d='M10 22c2-2 3 2 6 0s4 2 6 0' fill='none' stroke='%23ff3355' stroke-width='2.4' stroke-linecap='round'/%3E%3C/svg%3E">
<title>octopool · control room</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400&family=Instrument+Serif:ital@0;1&display=swap">
<style>
  :root{color-scheme:dark;--bg:#08080c;--text:#ebe7dc;--body:#cdc8bc;--muted:#a09a8c;--dim:#625d51;--red:#ff3355;--amber:#e6b45c;--green:#5dc98f;--rule:#232330;--rule-soft:#17171f;--serif:"Instrument Serif","Iowan Old Style",Georgia,serif;--mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
  *{box-sizing:border-box}
  html{min-width:320px;background:var(--bg)}
  body{margin:0;background:var(--bg);color:var(--text);font:400 13px/1.55 var(--mono);-webkit-font-smoothing:antialiased}
  body::before{content:"";position:fixed;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--red) 0 28%,rgba(255,51,85,.35) 62%,transparent);z-index:60}
  body::after{content:"";position:fixed;inset:0;pointer-events:none;opacity:.045;z-index:50;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E")}
  ::selection{background:var(--red);color:#fff}
  main{max-width:1360px;margin:0 auto;padding:0 40px 88px}
  main>*{animation:rise .55s both}
  main>:nth-child(2){animation-delay:.05s}main>:nth-child(3){animation-delay:.1s}main>:nth-child(4){animation-delay:.15s}main>:nth-child(5){animation-delay:.2s}main>:nth-child(6){animation-delay:.25s}main>:nth-child(7){animation-delay:.3s}main>:nth-child(8){animation-delay:.34s}
  .mast-top{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:20px 0;border-bottom:1px solid var(--rule)}
  .wordmark{display:inline-flex;align-items:center;gap:10px;color:var(--text);text-decoration:none}
  .wordmark svg{display:block}
  .wordmark b{font:600 13px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase}
  .wordmark em{font:500 9.5px/1 var(--mono);font-style:normal;color:var(--red);letter-spacing:.2em;text-transform:uppercase;padding-top:1px}
  .mast-nav{display:flex;align-items:center;gap:24px}
  .mast-nav a{color:var(--muted);text-decoration:none;font:500 10px/1 var(--mono);letter-spacing:.16em;text-transform:uppercase;border-bottom:1px solid transparent;padding-bottom:2px;transition:color .2s,border-color .2s}
  .mast-nav a:hover{color:var(--text);border-color:var(--red)}
  .mast-hero{display:flex;justify-content:space-between;align-items:flex-end;gap:44px;padding:46px 0 32px}
  h1{margin:0;font:400 clamp(40px,5vw,58px)/.95 var(--serif);letter-spacing:-.01em}
  .dek{margin:14px 0 0;color:var(--muted);font-size:12.5px;max-width:52ch}
  .console{display:flex;align-items:flex-end;gap:14px;flex:0 0 auto}
  .console label{display:block;margin-bottom:7px;color:var(--dim);font:600 9.5px/1 var(--mono);letter-spacing:.18em;text-transform:uppercase}
  .console input{width:200px;background:transparent;border:0;border-bottom:1px solid var(--rule);border-radius:0;color:var(--text);font:500 14px/1 var(--mono);padding:7px 2px;outline:0;transition:border-color .2s}
  .console input:focus{border-color:var(--red)}
  button{border:0;border-radius:3px;background:var(--text);color:#0a0a0f;height:34px;padding:0 16px;font:600 10.5px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;cursor:pointer;transition:background .18s,color .18s,transform .18s}
  button:hover{background:var(--red);color:#fff;transform:translateY(-1px)}
  button:focus-visible{outline:2px solid var(--red);outline-offset:3px}
  button:disabled{cursor:wait;opacity:.55;transform:none}
  .wire-line{display:flex;flex-wrap:wrap;align-items:center;gap:10px 12px;padding:12px 2px;border-top:1px solid var(--rule);border-bottom:1px solid var(--rule);color:var(--muted);font:500 10.5px/1.4 var(--mono);letter-spacing:.06em}
  .wire-line strong{color:var(--text);font-weight:600}
  .wire-note{color:var(--dim)}
  .beacon{width:7px;height:7px;border-radius:50%;background:var(--dim);flex:0 0 auto}
  .wire-line.on .beacon{background:var(--red);animation:pulse 2.2s ease-out infinite}
  .error{display:none;margin:16px 0 0;padding:10px 14px;border-left:2px solid var(--red);background:rgba(255,51,85,.07);color:#ff8fa0;font-size:11.5px}
  .figures{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border-bottom:1px solid var(--rule)}
  .figure{padding:28px 24px 26px;border-left:1px solid var(--rule);min-width:0}
  .figure:first-child{border-left:0;padding-left:2px}
  .figure span{display:block;color:var(--muted);font:600 9.5px/1.3 var(--mono);letter-spacing:.15em;text-transform:uppercase}
  .figure b{display:block;margin:12px 0 9px;font:400 40px/1 var(--serif);letter-spacing:0}
  .figure small{display:block;color:var(--dim);font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .figure.warn b{color:var(--amber)}
  .figure.hot b{color:var(--red)}
  .sect{padding-top:38px;min-width:0}
  .sect-head{display:flex;align-items:baseline;gap:14px;padding-bottom:10px;border-bottom:1px solid var(--rule)}
  .idx{color:var(--red);font:600 10px/1 var(--mono);letter-spacing:.1em}
  h2{margin:0;font:italic 400 21px/1.1 var(--serif);letter-spacing:.01em}
  .note{margin-left:auto;color:var(--dim);font:500 9.5px/1.3 var(--mono);letter-spacing:.14em;text-transform:uppercase;text-align:right}
  .duo{display:grid;grid-template-columns:1fr 1fr;gap:0 56px}
  .table-wrap{overflow-x:auto}
  table{width:100%;border-collapse:collapse}
  th{padding:12px 14px 8px;border-bottom:1px solid var(--rule-soft);color:var(--dim);font:600 9px/1.3 var(--mono);letter-spacing:.14em;text-transform:uppercase;text-align:left;white-space:nowrap}
  td{padding:9px 14px;border-bottom:1px solid var(--rule-soft);color:var(--body);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:420px;font-variant-numeric:tabular-nums}
  th:first-child,td:first-child{padding-left:2px}
  th:last-child,td:last-child{padding-right:2px}
  td:first-child{color:var(--text)}
  th.num,td.num{text-align:right}
  tbody tr{transition:background .15s}
  tbody tr:hover{background:rgba(255,51,85,.045)}
  .pill{display:inline-block;min-width:36px;padding:2px 7px;border:1px solid var(--rule);border-radius:3px;text-align:center;font:600 10px/1.5 var(--mono);color:var(--body)}
  .pill.ok{color:var(--green);border-color:rgba(93,201,143,.32);background:rgba(93,201,143,.06)}
  .pill.warn{color:var(--amber);border-color:rgba(230,180,92,.32);background:rgba(230,180,92,.06)}
  .pill.hot{color:var(--red);border-color:rgba(255,51,85,.32);background:rgba(255,51,85,.07)}
  .gauges{padding-top:4px}
  .gauge{display:grid;grid-template-columns:minmax(180px,260px) minmax(0,1fr) 90px;grid-template-areas:"label meter value";gap:18px;align-items:center;padding:10px 0;border-bottom:1px solid var(--rule-soft);color:var(--muted);font-size:11px}
  .glabel{grid-area:label;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .gval{grid-area:value;text-align:right;color:var(--text);font-size:11.5px;font-variant-numeric:tabular-nums}
  .meter{grid-area:meter;position:relative;height:4px;background:var(--rule-soft)}
  .meter::after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,transparent 0,transparent calc(25% - 1px),var(--bg) calc(25% - 1px),var(--bg) 25%)}
  .fill{position:absolute;top:0;bottom:0;left:0;width:0;background:var(--text);transition:width .6s ease}
  .fill.warn{background:var(--amber)}
  .fill.hot{background:var(--red)}
  .empty{padding:14px 2px;border-bottom:1px solid var(--rule-soft);color:var(--dim);font-style:italic;font-size:11.5px}
  td .empty,td.empty{border-bottom:0;padding:14px 0}
  @keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(255,51,85,.5)}70%{box-shadow:0 0 0 6px rgba(255,51,85,0)}100%{box-shadow:0 0 0 0 rgba(255,51,85,0)}}
  @media (max-width:1100px){
    .duo{grid-template-columns:1fr}
    .figures{grid-template-columns:repeat(3,minmax(0,1fr))}
    .figure:nth-child(3n+1){border-left:0;padding-left:2px}
    .figure:nth-child(n+4){border-top:1px solid var(--rule)}
  }
  @media (max-width:760px){
    main{padding:0 20px 64px}
    .mast-hero{flex-direction:column;align-items:stretch;gap:26px;padding:32px 0 26px}
    .console input{width:100%;flex:1}
    .console{width:100%}
    .figures{grid-template-columns:repeat(2,minmax(0,1fr))}
    .figure:nth-child(odd){border-left:0;padding-left:2px}
    .figure:nth-child(even){border-left:1px solid var(--rule)}
    .figure:nth-child(n+3){border-top:1px solid var(--rule)}
    .gauge{grid-template-columns:minmax(0,1fr) 80px;grid-template-areas:"label label" "meter value";gap:8px 14px}
    .table-wrap table{min-width:600px}
  }
  @media (max-width:480px){
    .figures{grid-template-columns:1fr}
    .figure:nth-child(n){border-left:0;border-top:1px solid var(--rule);padding-left:2px}
    .figure:first-child{border-top:0}
    .mast-nav{gap:16px}
    .figure b{font-size:34px}
  }
  @media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
</style>
</head>
<body>
<main>
  <header>
    <div class="mast-top">
      <a class="wordmark" href="/dashboard">
        <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="13" r="6.5" fill="#ff3355"/><path d="M10 22c2-2 3 2 6 0s4 2 6 0" fill="none" stroke="#ff3355" stroke-width="2.4" stroke-linecap="round"/></svg>
        <b>octopool</b><em>operator wire</em>
      </a>
      <nav class="mast-nav">
        <a href="https://docs.octopool.dev/">Docs</a>
        <a href="/logout">Log out</a>
      </nav>
    </div>
    <div class="mast-hero">
      <div>
        <h1>Relay control room</h1>
        <p class="dek">GitHub capacity, shared cache, and maintainer traffic — one pool at a time.</p>
      </div>
      <div class="console">
        <div style="flex:1;min-width:0">
          <label for="pool">Pool</label>
          <input id="pool" value="maintainers" spellcheck="false" autocomplete="off">
        </div>
        <button id="load">Refresh</button>
      </div>
    </div>
    <div class="wire-line" id="who"><span class="beacon"></span><strong>Loading</strong><span class="wire-note">Checking web session.</span></div>
    <div class="error" id="error" role="alert" aria-live="polite"></div>
  </header>
  <section class="figures" id="tiles" aria-label="Key figures"></section>
  <section class="sect">
    <div class="sect-head"><span class="idx">01</span><h2>Identity limits</h2><span class="note" id="rate-count"></span></div>
    <div class="gauges" id="rates"></div>
  </section>
  <div class="duo">
    <section class="sect">
      <div class="sect-head"><span class="idx">02</span><h2>Cache by route</h2><span class="note">fresh / total</span></div>
      <div class="table-wrap"><table><thead><tr><th>Route</th><th class="num">Fresh</th><th class="num">Total</th><th class="num">Latest</th></tr></thead><tbody id="cache-routes"></tbody></table></div>
    </section>
    <section class="sect">
      <div class="sect-head"><span class="idx">03</span><h2>Fallback &amp; failure causes</h2><span class="note">7 days</span></div>
      <div class="table-wrap"><table><thead><tr><th>Outcome</th><th>Route</th><th class="num">Requests</th><th class="num">Latest</th></tr></thead><tbody id="error-codes"></tbody></table></div>
    </section>
  </div>
  <section class="sect">
    <div class="sect-head"><span class="idx">04</span><h2>Top routes</h2><span class="note">24 hours</span></div>
    <div class="table-wrap"><table><thead><tr><th>Route</th><th class="num">Requests</th><th class="num">Eligible hit</th><th class="num">Coalesced</th><th class="num">Fallback</th><th class="num">Svc errors</th></tr></thead><tbody id="route-usage"></tbody></table></div>
  </section>
  <section class="sect">
    <div class="sect-head"><span class="idx">05</span><h2>Request patterns</h2><span class="note">7 days · normalized keys</span></div>
    <div class="table-wrap"><table><thead><tr><th>Route key</th><th class="num">Requests</th><th class="num">Hits</th><th class="num">Misses</th><th class="num">Coalesced</th><th class="num">Fallback</th><th class="num">Latest</th></tr></thead><tbody id="route-keys"></tbody></table></div>
  </section>
  <section class="sect">
    <div class="sect-head"><span class="idx">06</span><h2>Callers</h2><span class="note">7 days</span></div>
    <div class="table-wrap"><table><thead><tr><th>User</th><th class="num">Requests</th><th class="num">Errors</th><th class="num">Avg ms</th><th class="num">Last seen</th></tr></thead><tbody id="callers"></tbody></table></div>
  </section>
  <section class="sect">
    <div class="sect-head"><span class="idx">07</span><h2>Client sessions</h2><span class="note">7 days</span></div>
    <div class="table-wrap"><table><thead><tr><th>User</th><th>Client</th><th class="num">Requests</th><th class="num">Saved</th><th class="num">Backend</th><th class="num">Errors</th><th class="num">Last seen</th></tr></thead><tbody id="clients"></tbody></table></div>
  </section>
  <section class="sect">
    <div class="sect-head"><span class="idx">08</span><h2>Recent traffic</h2><span class="note">latest 20</span></div>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Caller</th><th>Client</th><th>Route</th><th>Status</th><th>Identity</th></tr></thead><tbody id="recent"></tbody></table></div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const poolInput = $("pool");
const loadButton = $("load");
let loadSerial = 0;
poolInput.value = localStorage.getItem("octopool.pool") || "maintainers";
loadButton.addEventListener("click", load);
poolInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") load();
});
load();

async function load() {
  const serial = (loadSerial += 1);
  const pool = poolInput.value.trim() || "maintainers";
  localStorage.setItem("octopool.pool", pool);
  const err = $("error");
  err.style.display = "none";
  loadButton.disabled = true;
  loadButton.textContent = "Refreshing...";
  try {
    const response = await fetch("/v1/dashboard?pool=" + encodeURIComponent(pool), {
      headers: { accept: "application/json" },
      credentials: "same-origin",
    });
    const data = await response.json().catch(() => ({}));
    if (serial !== loadSerial) return;
    if (response.status === 401 && data.error && (
      data.error.code === "missing_web_session" || data.error.code === "invalid_web_session"
    )) {
      window.location.href = "/login/github?next=/dashboard";
      return;
    }
    if (!response.ok) {
      resetDashboard();
      return showError((data.error && data.error.message) || "Dashboard request failed.");
    }
    render(data);
  } catch {
    if (serial === loadSerial) {
      resetDashboard();
      showError("Dashboard request failed.");
    }
  } finally {
    if (serial === loadSerial) {
      loadButton.disabled = false;
      loadButton.textContent = "Refresh";
    }
  }
}

function render(data) {
  const who = $("who");
  who.classList.add("on");
  const note = el("span", "pool " + data.pool + " · updated " + rel(data.generated_at), "wire-note");
  note.title = data.generated_at;
  who.replaceChildren(el("span", "", "beacon"), el("strong", data.operator.github_login), note);
  $("tiles").replaceChildren(
    tile("Requests / 24h", fmt(data.usage.requests_24h), fmt(data.usage.service_errors_24h) + " svc · " + fmt(data.usage.fallbacks_24h) + " fallback · " + fmt(data.usage.denied_24h) + " denied", data.usage.service_errors_24h ? "hot" : ""),
    tile("Eligible cache hit", pct(data.usage.eligible_cache_hit_rate_24h), pct(data.usage.cache_hit_rate_24h) + " raw · " + fmt(data.usage.coalesced_24h) + " coalesced"),
    tile("Average latency", Math.round(data.usage.avg_duration_ms_24h || 0) + " ms", "relay response time", data.usage.avg_duration_ms_24h > 1000 ? "warn" : ""),
    tile("Fresh cache", fmt(data.cache.fresh_entries), fmt(data.cache.total_entries) + " entries · " + bytes(data.cache.body_bytes)),
    tile("Identity health", fmt(data.identities.active) + "/" + fmt(data.identities.total), data.coordinator.cooldowns.length + " cooldowns", data.coordinator.cooldowns.length ? "warn" : ""),
  );
  renderRates(data);
  rows("cache-routes", data.cache.routes, (item) => [item.route_kind, fmt(item.fresh_entries), fmt(item.entries), rel(item.latest_created_at)]);
  rows("error-codes", data.error_codes_7d, (item) => [item.outcome, item.route_kind, fmt(item.requests), rel(item.latest_seen_at)]);
  rows("route-usage", data.route_usage, (item) => [item.route_kind, fmt(item.requests), pct(item.eligible_cache_hit_rate), fmt(item.coalesced), fmt(item.fallbacks), fmt(item.service_errors)]);
  rows("route-keys", data.route_keys_7d, (item) => [item.route_key, fmt(item.requests), fmt(item.cache_hits), fmt(item.cache_misses), fmt(item.coalesced), fmt(item.fallbacks), rel(item.latest_seen_at)]);
  rows("callers", data.users, (item) => [item.github_login, fmt(item.requests), fmt(item.errors), fmt(Math.round(item.avg_duration_ms || 0)), rel(item.last_seen)]);
  rows("clients", data.clients, (item) => [item.github_login, item.client_name, fmt(item.requests), fmt(item.saved_github_requests), fmt(item.backend_requests), fmt(item.errors), rel(item.last_seen)]);
  rows("recent", data.recent, (item) => [rel(item.created_at), item.github_login, item.client_name || "legacy", item.route_kind, statusPill(item.status, item.fallback_reason || item.error_code), item.identity_id || "none"]);
}

function renderRates(data) {
  const identities = new Map(data.identities.items.map((item) => [item.id, item]));
  $("rate-count").textContent = data.coordinator.rates.length + " resources";
  const target = $("rates");
  target.replaceChildren();
  if (!data.coordinator.rates.length) {
    target.append(el("div", "No rate-limit responses recorded yet.", "empty"));
    return;
  }
  for (const rate of data.coordinator.rates) {
    const identity = identities.get(rate.identity_id);
    const label = (identity ? identity.login : rate.identity_id) + " / " + rate.resource;
    const row = el("div", "", "gauge");
    row.append(el("div", label, "glabel"), meter(ratePercent(rate)), el("div", fmt(rate.remaining), "gval"));
    target.append(row);
  }
}

function ratePercent(rate) {
  const limit = Number(rate.limit_count || 0);
  if (limit <= 0) return 0;
  return Math.max(0, Math.min(100, (Number(rate.remaining || 0) / limit) * 100));
}

function rows(id, items, map) {
  const body = $(id);
  const ths = body.closest("table").tHead.rows[0].cells;
  body.replaceChildren();
  if (!items.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = ths.length;
    td.className = "empty";
    td.textContent = "No data yet.";
    tr.append(td);
    body.append(tr);
    return;
  }
  for (const item of items) {
    const tr = document.createElement("tr");
    map(item).forEach((value, index) => {
      const td = document.createElement("td");
      td.className = ths[index] ? ths[index].className : "";
      if (value instanceof Node) td.append(value);
      else {
        const text = String(value ?? "");
        td.textContent = text;
        if (text.length > 26) td.title = text;
      }
      tr.append(td);
    });
    body.append(tr);
  }
}

function tile(label, value, detail, tone) {
  const node = el("div", "", "figure" + (tone ? " " + tone : ""));
  node.append(el("span", label), el("b", value), el("small", detail));
  return node;
}
function meter(pct) {
  const m = el("div", "", "meter");
  const f = el("div", "", "fill" + (pct < 12 ? " hot" : pct < 30 ? " warn" : ""));
  f.style.width = pct + "%";
  m.append(f);
  return m;
}
function statusPill(status, title) {
  const kind = status >= 500 ? "hot" : status >= 400 ? "warn" : "ok";
  const node = el("span", String(status), "pill " + kind);
  if (title) node.title = title;
  return node;
}
function resetDashboard() {
  const who = $("who");
  who.classList.remove("on");
  who.replaceChildren(el("span", "", "beacon"), el("strong", "Not loaded"), el("span", "Use your GitHub web login.", "wire-note"));
  $("tiles").replaceChildren();
  $("rates").replaceChildren();
  $("rate-count").textContent = "";
  for (const id of ["cache-routes", "route-usage", "route-keys", "error-codes", "callers", "clients", "recent"]) $(id).replaceChildren();
  $("error").style.display = "none";
}
function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}
function fmt(value) { return Number(value || 0).toLocaleString(); }
function pct(value) {
  if (value === null || value === undefined) return "n/a";
  return (Number(value) * 100).toFixed(1) + "%";
}
function bytes(value) {
  const n = Number(value || 0);
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MiB";
  if (n > 1024) return (n / 1024).toFixed(1) + " KiB";
  return n + " B";
}
function rel(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const seconds = Math.round((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return seconds + "s ago";
  if (seconds < 3600) return Math.round(seconds / 60) + "m ago";
  if (seconds < 86400) return Math.round(seconds / 3600) + "h ago";
  return d.toISOString().slice(0, 10);
}
function showError(message) {
  const err = $("error");
  err.textContent = message;
  err.style.display = "block";
}
</script>
</body>
</html>`;

export function dashboardResponse(): Response {
  return new Response(DASHBOARD_HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
