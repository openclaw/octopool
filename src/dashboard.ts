const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0d1015">
<title>octopool dashboard</title>
<style>
  :root{color-scheme:dark;--bg:#0d1015;--panel:#151922;--line:#28303e;--text:#f2f4f8;--muted:#9ba7b7;--hot:#ff4d6d;--ok:#4fd18b;--warn:#f3bc4c;--ink:#080a0d}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
  main{min-height:100vh;padding:22px}
  header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin:0 auto 18px;max-width:1380px}
  h1{margin:0;font-size:22px;line-height:1.1;font-weight:750;letter-spacing:0}
  .sub{margin:6px 0 0;color:var(--muted);font-size:13px}
  .shell{max-width:1380px;margin:0 auto;display:grid;grid-template-columns:260px minmax(0,1fr);gap:16px}
  aside,.panel,.tile{background:var(--panel);border:1px solid var(--line);border-radius:8px}
  aside{padding:14px;align-self:start;position:sticky;top:16px}
  label{display:block;color:var(--muted);font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:.08em;margin:0 0 7px}
  input{width:100%;height:38px;border:1px solid var(--line);border-radius:6px;background:#0b0e13;color:var(--text);padding:8px 10px;font:inherit}
  button,.linkbtn{height:38px;border:0;border-radius:6px;background:var(--text);color:var(--ink);padding:0 12px;font:700 13px/1 inherit;text-decoration:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
  button.secondary,.linkbtn.secondary{background:#222936;color:var(--text);border:1px solid var(--line)}
  .controls{display:grid;gap:10px}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .who{margin-top:14px;padding-top:14px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
  .who strong{display:block;color:var(--text);font-size:15px}
  .grid{display:grid;gap:16px}
  .tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
  .tile{padding:13px;min-height:86px}
  .tile span,.section-label{display:block;color:var(--muted);font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:.08em}
  .tile b{display:block;margin-top:8px;font-size:26px;line-height:1.05;letter-spacing:0}
  .tile small{display:block;margin-top:7px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .panel{padding:14px;overflow:hidden}
  .panel-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px}
  h2{margin:0;font-size:15px;letter-spacing:0}
  table{width:100%;border-collapse:collapse;table-layout:fixed}
  th,td{padding:9px 8px;border-top:1px solid var(--line);text-align:left;vertical-align:middle;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:750}
  td code{color:#dce6f4;background:#0b0e13;border:1px solid var(--line);border-radius:4px;padding:2px 5px}
  .pill{display:inline-flex;align-items:center;justify-content:center;min-width:52px;height:22px;padding:0 8px;border-radius:999px;background:#222936;color:var(--text);font-size:12px;font-weight:750}
  .pill.ok{background:rgba(79,209,139,.15);color:var(--ok)}
  .pill.warn{background:rgba(243,188,76,.14);color:var(--warn)}
  .pill.hot{background:rgba(255,77,109,.15);color:var(--hot)}
  .bars{display:grid;gap:8px}
  .bar{display:grid;grid-template-columns:150px minmax(0,1fr) 80px;align-items:center;gap:10px;color:var(--muted)}
  .meter{height:8px;border-radius:999px;background:#0b0e13;overflow:hidden}
  .fill{height:100%;width:0;background:linear-gradient(90deg,var(--hot),var(--ok))}
  .empty{padding:18px;color:var(--muted);border:1px dashed var(--line);border-radius:6px}
  .error{display:none;margin-top:12px;padding:10px;border-radius:6px;background:rgba(255,77,109,.12);color:#ff9aae;border:1px solid rgba(255,77,109,.28)}
  @media (max-width:980px){main{padding:14px}.shell{grid-template-columns:1fr}.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}aside{position:static}.bar{grid-template-columns:1fr}}
  @media (max-width:560px){header{display:block}.tiles{grid-template-columns:1fr}th:nth-child(n+4),td:nth-child(n+4){display:none}}
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>octopool dashboard</h1>
      <p class="sub">GitHub relay limits, shared cache, and maintainer traffic.</p>
    </div>
    <a class="linkbtn secondary" href="https://docs.octopool.dev/">Docs</a>
  </header>
  <div class="shell">
    <aside>
      <div class="controls">
        <div><label for="pool">Pool</label><input id="pool" value="maintainers" spellcheck="false"></div>
        <div class="row"><button id="load">Refresh</button><a class="linkbtn secondary" href="/logout">Logout</a></div>
      </div>
      <div class="who" id="who"><strong>Loading</strong><span>Checking web session.</span></div>
      <div class="error" id="error"></div>
    </aside>
    <section class="grid">
      <div class="tiles" id="tiles"></div>
      <div class="panel">
        <div class="panel-head"><h2>Identity Limits</h2><span class="section-label" id="rate-count"></span></div>
        <div class="bars" id="rates"></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Cache By Route</h2><span class="section-label">fresh / total</span></div>
        <table><thead><tr><th>Route</th><th>Fresh</th><th>Total</th><th>Latest</th></tr></thead><tbody id="cache-routes"></tbody></table>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Top Routes</h2><span class="section-label">24 hours</span></div>
        <table><thead><tr><th>Route</th><th>Requests</th><th>Hit rate</th><th>Bypass</th><th>Errors</th></tr></thead><tbody id="route-usage"></tbody></table>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Who Uses It</h2><span class="section-label">7 days</span></div>
        <table><thead><tr><th>User</th><th>Requests</th><th>Errors</th><th>Avg ms</th><th>Last seen</th></tr></thead><tbody id="callers"></tbody></table>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Recent Traffic</h2><span class="section-label">latest 20</span></div>
        <table><thead><tr><th>When</th><th>Caller</th><th>Route</th><th>Status</th><th>Identity</th></tr></thead><tbody id="recent"></tbody></table>
      </div>
    </section>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const poolInput = $("pool");
let loadSerial = 0;
poolInput.value = localStorage.getItem("octopool.pool") || "maintainers";
$("load").addEventListener("click", load);
load();

async function load() {
  const serial = (loadSerial += 1);
  const pool = poolInput.value.trim() || "maintainers";
  localStorage.setItem("octopool.pool", pool);
  const err = $("error");
  err.style.display = "none";
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
}

function render(data) {
  $("who").replaceChildren(el("strong", data.operator.github_login), el("span", data.pool + " · " + data.generated_at));
  $("tiles").replaceChildren(
    tile("Requests 24h", fmt(data.usage.requests_24h), data.usage.errors_24h + " errors"),
    tile("Cache Hit 24h", pct(data.usage.cache_hit_rate_24h), data.usage.cache_misses_24h + " misses"),
    tile("Cache Fresh", fmt(data.cache.fresh_entries), fmt(data.cache.total_entries) + " total"),
    tile("Identities", fmt(data.identities.active) + "/" + fmt(data.identities.total), data.coordinator.cooldowns.length + " cooldowns"),
  );
  renderRates(data);
  rows("cache-routes", data.cache.routes, (item) => [item.route_kind, item.fresh_entries, item.entries, rel(item.latest_created_at)]);
  rows("route-usage", data.route_usage, (item) => [item.route_kind, item.requests, pct(item.cache_hit_rate), item.cache_bypass, item.errors]);
  rows("callers", data.users, (item) => [item.github_login, item.requests, item.errors, Math.round(item.avg_duration_ms || 0), rel(item.last_seen)]);
  rows("recent", data.recent, (item) => [rel(item.created_at), item.github_login, item.route_kind, statusPill(item.status), item.identity_id || "none"]);
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
    const pct = Math.max(0, Math.min(100, rate.remaining / 50));
    const row = el("div", "", "bar");
    row.append(el("div", label), meter(pct), el("div", fmt(rate.remaining)));
    target.append(row);
  }
}

function rows(id, items, map) {
  const body = $(id);
  body.replaceChildren();
  if (!items.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
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

function tile(label, value, detail) {
  const node = el("div", "", "tile");
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
function statusPill(status) {
  const kind = status >= 500 ? "hot" : status >= 400 ? "warn" : "ok";
  return el("span", String(status), "pill " + kind);
}
function resetDashboard() {
  $("who").replaceChildren(el("strong", "Not loaded"), el("span", "Use your GitHub web login."));
  $("tiles").replaceChildren();
  $("rates").replaceChildren();
  $("rate-count").textContent = "";
  for (const id of ["cache-routes", "route-usage", "callers", "recent"]) $(id).replaceChildren();
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
