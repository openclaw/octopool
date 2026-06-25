const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#07110f">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%230d1917'/%3E%3Ccircle cx='16' cy='14' r='7' fill='none' stroke='%2365e6b4' stroke-width='2'/%3E%3Cpath d='M10 22c2-2 3 2 6 0s4 2 6 0' fill='none' stroke='%2365e6b4' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E">
<title>octopool dashboard</title>
<style>
  :root{color-scheme:dark;--bg:#07110f;--panel:#0d1917;--panel-strong:#11211e;--line:#203a34;--line-soft:rgba(115,160,148,.16);--text:#f2f7f4;--muted:#8fa9a1;--dim:#648078;--mint:#65e6b4;--mint-soft:rgba(101,230,180,.12);--coral:#ff7a73;--coral-soft:rgba(255,122,115,.12);--amber:#f3c96b;--ink:#06100d;--shadow:0 24px 70px rgba(0,0,0,.28)}
  *{box-sizing:border-box}
  html{min-width:320px;background:var(--bg)}
  body{margin:0;background:
    radial-gradient(circle at 18% -10%,rgba(44,173,133,.17),transparent 31rem),
    radial-gradient(circle at 92% 8%,rgba(255,122,115,.07),transparent 25rem),
    linear-gradient(rgba(116,175,158,.035) 1px,transparent 1px),
    linear-gradient(90deg,rgba(116,175,158,.035) 1px,transparent 1px),
    var(--bg);background-size:auto,auto,32px 32px,32px 32px,auto;color:var(--text);font:14px/1.5 "Avenir Next","Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
  body::before{content:"";position:fixed;inset:0;pointer-events:none;background:linear-gradient(115deg,transparent 0 49.8%,rgba(101,230,180,.025) 50%,transparent 50.2%)}
  main{min-height:100vh;padding:34px 28px 56px}
  header{display:flex;align-items:flex-end;justify-content:space-between;gap:28px;margin:0 auto 24px;max-width:1460px}
  .brand{display:flex;align-items:flex-start;gap:14px}
  .brandmark{position:relative;flex:0 0 auto;width:42px;height:42px;border:1px solid rgba(101,230,180,.36);border-radius:13px;background:linear-gradient(145deg,rgba(101,230,180,.18),rgba(101,230,180,.03));box-shadow:inset 0 1px rgba(255,255,255,.08),0 10px 30px rgba(0,0,0,.18)}
  .brandmark::before{content:"";position:absolute;inset:9px;border:2px solid var(--mint);border-radius:50%}
  .brandmark::after{content:"";position:absolute;left:12px;right:12px;bottom:7px;height:7px;background:radial-gradient(circle,var(--mint) 2px,transparent 2.5px) 0 0/9px 7px}
  .eyebrow,.section-label{display:block;color:var(--mint);font:700 10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.15em}
  h1{margin:5px 0 0;font-size:27px;line-height:1.08;font-weight:650;letter-spacing:-.035em}
  .sub{margin:7px 0 0;color:var(--muted);font-size:13px}
  .header-actions{display:flex;align-items:center;gap:10px}
  .live{display:inline-flex;align-items:center;gap:8px;height:38px;padding:0 13px;border:1px solid var(--line-soft);border-radius:999px;background:rgba(13,25,23,.62);color:var(--muted);font:700 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.1em}
  .live::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--mint);box-shadow:0 0 0 4px rgba(101,230,180,.09),0 0 18px rgba(101,230,180,.55)}
  .shell{max-width:1460px;margin:0 auto;display:grid;grid-template-columns:242px minmax(0,1fr);gap:18px}
  aside,.panel,.tile{background:linear-gradient(145deg,rgba(17,33,30,.96),rgba(11,23,20,.96));border:1px solid var(--line-soft);box-shadow:inset 0 1px rgba(255,255,255,.025),var(--shadow)}
  aside{padding:17px;align-self:start;position:sticky;top:18px;border-radius:18px}
  .aside-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:17px}
  .aside-index{color:var(--dim);font:700 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace}
  label{display:block;color:var(--muted);font:700 10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.12em;margin:0 0 8px}
  input{width:100%;height:42px;border:1px solid var(--line);border-radius:10px;background:rgba(3,12,10,.72);color:var(--text);padding:9px 11px;font:600 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;outline:none;transition:border-color .18s,box-shadow .18s}
  input:focus{border-color:rgba(101,230,180,.68);box-shadow:0 0 0 3px rgba(101,230,180,.09)}
  button,.linkbtn{height:40px;border:1px solid transparent;border-radius:10px;background:var(--mint);color:var(--ink);padding:0 13px;font:750 12px/1 "Avenir Next","Segoe UI",sans-serif;text-decoration:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:transform .18s,background .18s,border-color .18s,color .18s}
  button:hover,.linkbtn:hover{transform:translateY(-1px)}
  button:focus-visible,.linkbtn:focus-visible{outline:2px solid var(--mint);outline-offset:3px}
  button:disabled{cursor:wait;opacity:.64;transform:none}
  button.secondary,.linkbtn.secondary{background:rgba(255,255,255,.035);color:var(--text);border-color:var(--line)}
  .controls{display:grid;gap:11px}
  .row{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center}
  .who{display:grid;grid-template-columns:36px minmax(0,1fr);gap:10px;align-items:center;margin-top:17px;padding-top:17px;border-top:1px solid var(--line-soft);color:var(--muted);font-size:11px;min-width:0}
  .avatar{display:grid;place-items:center;width:36px;height:36px;border:1px solid rgba(101,230,180,.26);border-radius:11px;background:var(--mint-soft);color:var(--mint);font:750 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase}
  .who-copy{min-width:0}
  .who strong{display:block;color:var(--text);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .who span{display:block;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .grid{display:grid;gap:18px;min-width:0}
  .tiles{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:11px}
  .tile{position:relative;overflow:hidden;padding:15px 15px 14px;min-height:112px;border-radius:16px;animation:rise .45s both}
  .tile:nth-child(2){animation-delay:.04s}.tile:nth-child(3){animation-delay:.08s}.tile:nth-child(4){animation-delay:.12s}.tile:nth-child(5){animation-delay:.16s}
  .tile::after{content:"";position:absolute;top:0;left:15px;width:34px;height:2px;border-radius:0 0 4px 4px;background:var(--mint);box-shadow:0 0 16px rgba(101,230,180,.55)}
  .tile.warn::after{background:var(--amber);box-shadow:0 0 16px rgba(243,201,107,.45)}
  .tile.hot::after{background:var(--coral);box-shadow:0 0 16px rgba(255,122,115,.45)}
  .tile span{display:block;color:var(--muted);font:700 9px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.12em}
  .tile b{display:block;margin-top:14px;font:650 27px/1 "Avenir Next","Segoe UI",sans-serif;letter-spacing:-.04em}
  .tile small{display:block;margin-top:9px;color:var(--dim);font:600 11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .panel{padding:0;overflow:hidden;border-radius:18px;animation:rise .45s .14s both}
  .panel-head{display:flex;justify-content:space-between;align-items:center;gap:12px;min-height:57px;padding:0 17px;border-bottom:1px solid var(--line-soft);background:rgba(255,255,255,.012)}
  .panel-head .section-label{color:var(--dim)}
  h2{margin:0;font-size:14px;font-weight:650;letter-spacing:-.01em}
  .table-wrap{overflow-x:auto}
  table{width:100%;border-collapse:collapse;table-layout:fixed}
  th,td{padding:10px 17px;border-bottom:1px solid var(--line-soft);text-align:left;vertical-align:middle;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  tbody tr:last-child td{border-bottom:0}
  tbody tr{transition:background .15s}
  tbody tr:hover{background:rgba(101,230,180,.035)}
  th{color:var(--dim);font:700 9px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.12em}
  td{color:#dbe8e3;font-size:12px}
  td:first-child{color:var(--text);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
  .pill{display:inline-flex;align-items:center;justify-content:center;min-width:49px;height:23px;padding:0 8px;border:1px solid var(--line);border-radius:7px;background:rgba(255,255,255,.04);color:var(--text);font:750 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace}
  .pill.ok{border-color:rgba(101,230,180,.24);background:var(--mint-soft);color:var(--mint)}
  .pill.warn{border-color:rgba(243,201,107,.24);background:rgba(243,201,107,.1);color:var(--amber)}
  .pill.hot{border-color:rgba(255,122,115,.24);background:var(--coral-soft);color:var(--coral)}
  .bars{display:grid;gap:14px;padding:18px 17px 20px}
  .bar{display:grid;grid-template-columns:190px minmax(0,1fr) 80px;align-items:center;gap:14px;color:var(--muted);font:600 11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace}
  .bar>div:last-child{text-align:right;color:var(--text)}
  .meter{height:7px;border-radius:999px;background:#05100d;overflow:hidden;box-shadow:inset 0 0 0 1px rgba(115,160,148,.12)}
  .fill{height:100%;width:0;border-radius:inherit;background:linear-gradient(90deg,var(--coral),var(--amber) 42%,var(--mint));box-shadow:0 0 16px rgba(101,230,180,.24);transition:width .55s ease}
  .empty{margin:10px 0;padding:16px;color:var(--dim);border:1px dashed var(--line);border-radius:10px;background:rgba(3,12,10,.3)}
  td .empty{margin:0}
  .error{display:none;margin-top:13px;padding:11px;border-radius:10px;background:var(--coral-soft);color:#ffaaa5;border:1px solid rgba(255,122,115,.26);font-size:12px}
  @keyframes rise{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}
  @media (max-width:1160px){.tiles{grid-template-columns:repeat(3,minmax(0,1fr))}.tile:nth-child(n+4){grid-column:span 1}}
  @media (max-width:900px){main{padding:22px 16px 40px}.shell{grid-template-columns:1fr}.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}aside{position:static}.controls{grid-template-columns:minmax(0,1fr) auto;align-items:end}.who{margin-top:14px;padding:14px 0 0;border-top:1px solid var(--line-soft);border-left:0}.error{grid-column:1/-1}.bar{grid-template-columns:1fr}.bar>div:last-child{text-align:left}}
  @media (max-width:620px){header{align-items:flex-start}.header-actions{align-items:flex-end;flex-direction:column}.live{height:32px}.shell{gap:14px}.controls{grid-template-columns:1fr}.tiles{grid-template-columns:1fr 1fr}.tile{min-height:104px}.panel-head{padding:0 13px}th,td{padding:10px 13px;min-width:105px}table{min-width:620px}}
  @media (max-width:430px){main{padding:18px 12px 32px}.brandmark{display:none}.header-actions .live{display:none}h1{font-size:23px}.sub{max-width:230px}.tiles{grid-template-columns:1fr}.tile{min-height:96px}}
  @media (prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
</style>
</head>
<body>
<main>
  <header>
    <div class="brand">
      <div class="brandmark" aria-hidden="true"></div>
      <div>
        <span class="eyebrow">Octopool / operator</span>
        <h1>Relay control room</h1>
        <p class="sub">GitHub capacity, shared cache, and maintainer traffic.</p>
      </div>
    </div>
    <div class="header-actions">
      <span class="live">Session active</span>
      <a class="linkbtn secondary" href="https://docs.octopool.dev/">Documentation</a>
    </div>
  </header>
  <div class="shell">
    <aside>
      <div class="aside-head"><span class="section-label">Workspace</span><span class="aside-index">01</span></div>
      <div class="controls">
        <div><label for="pool">Pool</label><input id="pool" value="maintainers" spellcheck="false"></div>
        <div class="row"><button id="load">Refresh data</button><a class="linkbtn secondary" href="/logout">Log out</a></div>
      </div>
      <div class="who" id="who">
        <div class="avatar" aria-hidden="true">...</div>
        <div class="who-copy"><strong>Loading</strong><span>Checking web session.</span></div>
      </div>
      <div class="error" id="error" role="alert" aria-live="polite"></div>
    </aside>
    <section class="grid">
      <div class="tiles" id="tiles"></div>
      <div class="panel">
        <div class="panel-head"><h2>Identity Limits</h2><span class="section-label" id="rate-count"></span></div>
        <div class="bars" id="rates"></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Cache By Route</h2><span class="section-label">fresh / total</span></div>
        <div class="table-wrap"><table><thead><tr><th>Route</th><th>Fresh</th><th>Total</th><th>Latest</th></tr></thead><tbody id="cache-routes"></tbody></table></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Top Routes</h2><span class="section-label">24 hours</span></div>
        <div class="table-wrap"><table><thead><tr><th>Route</th><th>Requests</th><th>Eligible hit</th><th>Coalesced</th><th>Fallback</th><th>Svc errors</th></tr></thead><tbody id="route-usage"></tbody></table></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Request Patterns</h2><span class="section-label">7 days / normalized keys</span></div>
        <div class="table-wrap"><table><thead><tr><th>Route key</th><th>Requests</th><th>Hits</th><th>Misses</th><th>Coalesced</th><th>Fallback</th><th>Latest</th></tr></thead><tbody id="route-keys"></tbody></table></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Fallback & Failure Causes</h2><span class="section-label">7 days</span></div>
        <div class="table-wrap"><table><thead><tr><th>Outcome</th><th>Route</th><th>Requests</th><th>Latest</th></tr></thead><tbody id="error-codes"></tbody></table></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Who Uses It</h2><span class="section-label">7 days</span></div>
        <div class="table-wrap"><table><thead><tr><th>User</th><th>Requests</th><th>Errors</th><th>Avg ms</th><th>Last seen</th></tr></thead><tbody id="callers"></tbody></table></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Recent Traffic</h2><span class="section-label">latest 20</span></div>
        <div class="table-wrap"><table><thead><tr><th>When</th><th>Caller</th><th>Route</th><th>Status</th><th>Identity</th></tr></thead><tbody id="recent"></tbody></table></div>
      </div>
    </section>
  </div>
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
      loadButton.textContent = "Refresh data";
    }
  }
}

function render(data) {
  const avatar = el("div", data.operator.github_login.slice(0, 2), "avatar");
  avatar.setAttribute("aria-hidden", "true");
  const whoCopy = el("div", "", "who-copy");
  const generated = el("span", data.pool + " · updated " + rel(data.generated_at));
  generated.title = data.generated_at;
  whoCopy.append(el("strong", data.operator.github_login), generated);
  $("who").replaceChildren(avatar, whoCopy);
  $("tiles").replaceChildren(
    tile("Requests / 24h", fmt(data.usage.requests_24h), fmt(data.usage.service_errors_24h) + " svc · " + fmt(data.usage.fallbacks_24h) + " fallback · " + fmt(data.usage.denied_24h) + " denied", data.usage.service_errors_24h ? "hot" : ""),
    tile("Eligible cache hit", pct(data.usage.eligible_cache_hit_rate_24h), pct(data.usage.cache_hit_rate_24h) + " raw · " + fmt(data.usage.coalesced_24h) + " coalesced"),
    tile("Average latency", Math.round(data.usage.avg_duration_ms_24h || 0) + " ms", "relay response time", data.usage.avg_duration_ms_24h > 1000 ? "warn" : ""),
    tile("Fresh cache", fmt(data.cache.fresh_entries), fmt(data.cache.total_entries) + " entries · " + bytes(data.cache.body_bytes)),
    tile("Identity health", fmt(data.identities.active) + "/" + fmt(data.identities.total), data.coordinator.cooldowns.length + " cooldowns", data.coordinator.cooldowns.length ? "warn" : ""),
  );
  renderRates(data);
  rows("cache-routes", data.cache.routes, (item) => [item.route_kind, item.fresh_entries, item.entries, rel(item.latest_created_at)], 4);
  rows("route-usage", data.route_usage, (item) => [item.route_kind, item.requests, pct(item.eligible_cache_hit_rate), item.coalesced, item.fallbacks, item.service_errors], 6);
  rows("route-keys", data.route_keys_7d, (item) => [item.route_key, item.requests, item.cache_hits, item.cache_misses, item.coalesced, item.fallbacks, rel(item.latest_seen_at)], 7);
  rows("error-codes", data.error_codes_7d, (item) => [item.outcome, item.route_kind, item.requests, rel(item.latest_seen_at)], 4);
  rows("callers", data.users, (item) => [item.github_login, item.requests, item.errors, Math.round(item.avg_duration_ms || 0), rel(item.last_seen)]);
  rows("recent", data.recent, (item) => [rel(item.created_at), item.github_login, item.route_kind, statusPill(item.status, item.fallback_reason || item.error_code), item.identity_id || "none"]);
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
    const label = (identity ? identity.login : rate.identity_id) + " · " + rate.resource;
    const row = el("div", "", "bar");
    row.append(el("div", label), meter(ratePercent(rate)), el("div", fmt(rate.remaining)));
    target.append(row);
  }
}

function ratePercent(rate) {
  const limit = Number(rate.limit_count || 0);
  if (limit <= 0) return 0;
  return Math.max(0, Math.min(100, (Number(rate.remaining || 0) / limit) * 100));
}

function rows(id, items, map, columns = 5) {
  const body = $(id);
  body.replaceChildren();
  if (!items.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = columns;
    td.append(el("div", "No data yet.", "empty"));
    tr.append(td);
    body.append(tr);
    return;
  }
  for (const item of items) {
    const tr = document.createElement("tr");
    for (const value of map(item)) {
      const td = document.createElement("td");
      if (value instanceof Node) td.append(value);
      else td.textContent = String(value ?? "");
      tr.append(td);
    }
    body.append(tr);
  }
}

function tile(label, value, detail, tone) {
  const node = el("div", "", "tile" + (tone ? " " + tone : ""));
  node.append(el("span", label), el("b", value), el("small", detail));
  return node;
}
function meter(pct) {
  const m = el("div", "", "meter");
  const f = el("div", "", "fill");
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
  const avatar = el("div", "--", "avatar");
  avatar.setAttribute("aria-hidden", "true");
  const whoCopy = el("div", "", "who-copy");
  whoCopy.append(el("strong", "Not loaded"), el("span", "Use your GitHub web login."));
  $("who").replaceChildren(avatar, whoCopy);
  $("tiles").replaceChildren();
  $("rates").replaceChildren();
  $("rate-count").textContent = "";
  for (const id of ["cache-routes", "route-usage", "route-keys", "error-codes", "callers", "recent"]) $(id).replaceChildren();
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
