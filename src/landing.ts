import { jsonResponse } from "./http";
import { APP_ORIGIN, isPublicRequest } from "./hosts";
import { wantsJson } from "./web-error";

const INSTALL_COMMAND = "brew install openclaw/tap/octopool";

// Host-aware landing page: octopool.openclaw.ai is the app/login site;
// octopool.dev stays mysterious and points at the Homebrew install.

const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#07070b">
<meta name="robots" content="noindex">
<title>octopool</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="octopool">
<meta property="og:title" content="octopool - a shared GitHub read relay">
<meta property="og:description" content="A shared, org-authenticated GitHub read relay and cache. Pooled GitHub identities for read-heavy maintainer automation.">
<meta property="og:url" content="https://octopool.dev/">
<meta property="og:image" content="https://docs.octopool.dev/assets/og-card.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="octopool - a shared GitHub read relay">
<meta name="twitter:description" content="A shared, org-authenticated GitHub read relay and cache.">
<meta name="twitter:image" content="https://docs.octopool.dev/assets/og-card.png">
<link rel="icon" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsPSJvY3RvcG9vbCI+CiAgPGRlZnM+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9ImJnIiB4MT0iMCIgeTE9IjAiIHgyPSIwIiB5Mj0iMSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzE2MTExZiIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiMwNzA3MGIiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9ImJvZHkiIHgxPSIwIiB5MT0iMCIgeDI9IjAiIHkyPSIxIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjZmY1YTc4Ii8+CiAgICAgIDxzdG9wIG9mZnNldD0iLjU1IiBzdG9wLWNvbG9yPSIjZDYxZjVjIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzdhMGY0MyIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0iYXJtIiB4MT0iMCIgeTE9IjAiIHgyPSIwIiB5Mj0iMSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iI2UyMWU1ZSIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiM1ZTBhMzYiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8cmFkaWFsR3JhZGllbnQgaWQ9Imdsb3ciIGN4PSI1MCUiIGN5PSI0NCUiIHI9IjU1JSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iI2ZmMjg1YSIgc3RvcC1vcGFjaXR5PSIuNTUiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSI1NSUiIHN0b3AtY29sb3I9IiNmZjI4NWEiIHN0b3Atb3BhY2l0eT0iLjEyIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iI2ZmMjg1YSIgc3RvcC1vcGFjaXR5PSIwIi8+CiAgICA8L3JhZGlhbEdyYWRpZW50PgogIDwvZGVmcz4KICA8cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxNCIgZmlsbD0idXJsKCNiZykiLz4KICA8Y2lyY2xlIGN4PSIzMiIgY3k9IjI5IiByPSIyNSIgZmlsbD0idXJsKCNnbG93KSIvPgogIDxnIGZpbGw9Im5vbmUiIHN0cm9rZT0idXJsKCNhcm0pIiBzdHJva2UtbGluZWNhcD0icm91bmQiPgogICAgPHBhdGggc3Ryb2tlLXdpZHRoPSI0LjQiIGQ9Ik0yMSAzMyBDMTUgNDEgMTQgNDkgMTggNTUiLz4KICAgIDxwYXRoIHN0cm9rZS13aWR0aD0iNS40IiBkPSJNMjcgMzYgQzI0IDQ1IDIzIDUyIDI2IDU3Ii8+CiAgICA8cGF0aCBzdHJva2Utd2lkdGg9IjUuNCIgZD0iTTM3IDM2IEM0MCA0NSA0MSA1MiAzOCA1NyIvPgogICAgPHBhdGggc3Ryb2tlLXdpZHRoPSI0LjQiIGQ9Ik00MyAzMyBDNDkgNDEgNTAgNDkgNDYgNTUiLz4KICA8L2c+CiAgPGVsbGlwc2UgY3g9IjMyIiBjeT0iMjciIHJ4PSIxOSIgcnk9IjE4IiBmaWxsPSJ1cmwoI2JvZHkpIi8+CiAgPGVsbGlwc2UgY3g9IjI1LjUiIGN5PSIyNi41IiByeD0iNi40IiByeT0iNi44IiBmaWxsPSIjZmZmIi8+CiAgPGVsbGlwc2UgY3g9IjM4LjUiIGN5PSIyNi41IiByeD0iNi40IiByeT0iNi44IiBmaWxsPSIjZmZmIi8+CiAgPGNpcmNsZSBjeD0iMjYuNCIgY3k9IjI4IiByPSIyLjgiIGZpbGw9IiMwYjBiMTIiLz4KICA8Y2lyY2xlIGN4PSIzNy42IiBjeT0iMjgiIHI9IjIuOCIgZmlsbD0iIzBiMGIxMiIvPgogIDxjaXJjbGUgY3g9IjI1LjMiIGN5PSIyNi43IiByPSIxIiBmaWxsPSIjZmZmIi8+CiAgPGNpcmNsZSBjeD0iMzYuNSIgY3k9IjI2LjciIHI9IjEiIGZpbGw9IiNmZmYiLz4KICA8cGF0aCBkPSJNMTYuNSAxNiBMMjkgMjIuNSIgc3Ryb2tlPSIjNGQwYTI4IiBzdHJva2Utd2lkdGg9IjMuNCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+CiAgPHBhdGggZD0iTTQ3LjUgMTYgTDM1IDIyLjUiIHN0cm9rZT0iIzRkMGEyOCIgc3Ryb2tlLXdpZHRoPSIzLjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgogIDxwYXRoIGQ9Ik0yOSAzNSBRMzIgMzIuNCAzNSAzNSIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjNGQwYTI4IiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K" type="image/svg+xml">
<link rel="apple-touch-icon" href="https://docs.octopool.dev/assets/apple-touch-icon.png">
<style>
  *{box-sizing:border-box}
  html,body{height:100%}
  body{
    margin:0;
    background:#07070b;
    color:#fff;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;
    overflow:hidden;
    -webkit-font-smoothing:antialiased;
  }
  .stage{
    position:fixed;
    inset:0;
    display:flex;
    flex-direction:column;
    align-items:center;
    justify-content:center;
    gap:clamp(28px,5vh,56px);
    padding:24px;
  }
  .glow{
    position:absolute;
    top:34%;
    left:50%;
    width:min(120vw,900px);
    height:min(120vw,900px);
    transform:translate(-50%,-50%);
    background:radial-gradient(circle,rgba(255,40,90,.18),rgba(255,40,90,.06) 38%,transparent 64%);
    filter:blur(8px);
    pointer-events:none;
    z-index:0;
    animation:breathe 7s ease-in-out infinite;
  }
  .float{position:relative;z-index:1;animation:bob 6s ease-in-out infinite}
  .tilt{will-change:transform;transition:transform .25s ease-out}
  .octo{
    display:block;
    width:clamp(220px,46vw,380px);
    height:auto;
    cursor:pointer;
    filter:drop-shadow(0 0 22px rgba(255,40,90,.45));
    animation:anger 2.6s ease-in-out infinite;
  }
  .tentacle{
    fill:none;
    stroke:url(#arm);
    stroke-linecap:round;
    transform-box:fill-box;
    transform-origin:50% 2%;
    animation:sway 4s ease-in-out infinite;
  }
  #arms .tentacle:nth-child(1){animation-name:swayWide;animation-duration:4.6s;animation-delay:-.1s}
  #arms .tentacle:nth-child(2){animation-name:swayWide;animation-duration:4.0s;animation-delay:-1.2s}
  #arms .tentacle:nth-child(3){animation-duration:4.4s;animation-delay:-2.0s}
  #arms .tentacle:nth-child(4){animation-duration:3.8s;animation-delay:-.6s}
  #arms .tentacle:nth-child(5){animation-duration:3.9s;animation-delay:-1.5s}
  #arms .tentacle:nth-child(6){animation-duration:4.3s;animation-delay:-2.4s}
  #arms .tentacle:nth-child(7){animation-name:swayWide;animation-duration:4.1s;animation-delay:-.9s}
  #arms .tentacle:nth-child(8){animation-name:swayWide;animation-duration:4.7s;animation-delay:-1.8s}
  .pupil{transition:transform .12s ease-out}
  .login{
    position:relative;
    z-index:2;
    display:inline-flex;
    align-items:center;
    gap:11px;
    padding:14px 24px;
    border-radius:13px;
    border:0;
    background:#fff;
    color:#0a0a0f;
    font-size:16px;
    font-weight:600;
    text-decoration:none;
    letter-spacing:-.01em;
    box-shadow:0 8px 30px rgba(0,0,0,.5);
    transition:transform .18s ease,box-shadow .18s ease;
    cursor:pointer;
  }
  .login:hover{transform:translateY(-2px) scale(1.02);box-shadow:0 12px 40px rgba(255,40,90,.35)}
  .login:active{transform:translateY(0) scale(.99)}
  .login svg{flex:0 0 auto}
  .login code{font:700 15px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:inherit;background:transparent}
  .prompt{font:800 17px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#d61f5c}
  .install-command{
    position:relative;
    z-index:2;
    display:inline-grid;
    grid-template-columns:auto minmax(0,max-content) auto;
    align-items:center;
    gap:14px;
    max-width:calc(100vw - 48px);
    padding:10px 11px 10px 20px;
    border:1px solid rgba(255,255,255,.13);
    border-radius:16px;
    background:linear-gradient(180deg,rgba(25,18,29,.88),rgba(9,9,14,.94));
    color:#f7edf2;
    box-shadow:0 18px 54px rgba(0,0,0,.52),0 0 38px rgba(255,40,90,.11),inset 0 1px 0 rgba(255,255,255,.08);
    backdrop-filter:blur(14px);
  }
  .install-command code{
    min-width:0;
    overflow:hidden;
    text-overflow:ellipsis;
    white-space:nowrap;
    font:700 16px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;
    color:#fff6fa;
    background:transparent;
    letter-spacing:-.005em;
  }
  .install-command .prompt{
    color:#ff4d82;
    text-shadow:0 0 14px rgba(255,40,90,.5);
  }
  .copy-command{
    display:grid;
    place-items:center;
    width:36px;
    height:36px;
    border:1px solid rgba(255,255,255,.12);
    border-radius:10px;
    background:rgba(255,255,255,.07);
    color:#ffd7e3;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.08);
    cursor:pointer;
    transition:background .18s ease,border-color .18s ease,color .18s ease,transform .18s ease,box-shadow .18s ease;
  }
  .copy-command:hover{
    transform:translateY(-1px);
    border-color:rgba(255,77,130,.42);
    background:rgba(255,77,130,.14);
    color:#fff;
    box-shadow:0 8px 24px rgba(255,40,90,.18),inset 0 1px 0 rgba(255,255,255,.12);
  }
  .copy-command:active{transform:translateY(0) scale(.98)}
  .copy-command[data-copied="true"]{color:#8fffd2;border-color:rgba(143,255,210,.42);background:rgba(143,255,210,.12)}
  .copy-command svg{width:17px;height:17px}
  .quick-links{
    position:relative;
    z-index:2;
    display:flex;
    gap:18px;
    align-items:center;
    justify-content:center;
    margin-top:calc(clamp(28px,5vh,56px) * -0.55);
  }
  .quick-links a{
    color:rgba(255,255,255,.64);
    font-size:13px;
    font-weight:600;
    text-decoration:none;
    letter-spacing:.08em;
    text-transform:uppercase;
    transition:color .18s ease,transform .18s ease;
  }
  .quick-links a:hover{color:#fff;transform:translateY(-1px)}
  .brand{
    position:absolute;
    bottom:26px;
    left:50%;
    transform:translateX(-50%);
    font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
    letter-spacing:.44em;
    text-transform:uppercase;
    color:#fff;
    opacity:.26;
  }
  @keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-16px)}}
  @keyframes breathe{0%,100%{opacity:.7;transform:translate(-50%,-50%) scale(1)}50%{opacity:1;transform:translate(-50%,-50%) scale(1.08)}}
  @keyframes anger{0%,100%{filter:drop-shadow(0 0 20px rgba(255,40,90,.4))}50%{filter:drop-shadow(0 0 42px rgba(255,18,70,.85))}}
  @keyframes sway{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3.5deg)}}
  @keyframes swayWide{0%,100%{transform:rotate(-6deg)}50%{transform:rotate(6deg)}}
  @keyframes rage{0%{transform:translateX(0) rotate(0)}15%{transform:translateX(-7px) rotate(-2.5deg)}35%{transform:translateX(7px) rotate(2.5deg)}55%{transform:translateX(-5px) rotate(-1.5deg)}75%{transform:translateX(5px) rotate(1.5deg)}100%{transform:translateX(0) rotate(0)}}
  .octo.rage{animation:rage .5s ease,anger 2.6s ease-in-out infinite}
  @media (prefers-reduced-motion:reduce){
    .glow,.float,.octo,.tentacle{animation:none!important}
  }
</style>
</head>
<body>
  <main class="stage">
    <div class="glow"></div>
    <div class="float">
      <div class="tilt" id="tilt">
        <svg class="octo" id="octo" viewBox="0 0 420 500" role="img" aria-label="An angry octopus">
          <defs>
            <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#ff4d6d"/>
              <stop offset=".55" stop-color="#d61f5c"/>
              <stop offset="1" stop-color="#7a0f43"/>
            </linearGradient>
            <linearGradient id="arm" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#e21e5e"/>
              <stop offset="1" stop-color="#5e0a36"/>
            </linearGradient>
          </defs>
          <g id="arms">
            <path class="tentacle" stroke-width="15" d="M120,236 C66,282 52,352 86,404 C104,432 92,468 120,470"/>
            <path class="tentacle" stroke-width="19" d="M152,250 C112,300 100,372 128,420 C142,446 128,476 154,476"/>
            <path class="tentacle" stroke-width="22" d="M182,258 C166,322 162,392 146,440 C138,464 150,486 174,480"/>
            <path class="tentacle" stroke-width="24" d="M203,262 C198,338 192,408 184,452 C180,476 196,488 210,480"/>
            <path class="tentacle" stroke-width="24" d="M217,262 C222,338 228,408 236,452 C240,476 224,488 210,480"/>
            <path class="tentacle" stroke-width="22" d="M238,258 C254,322 258,392 274,440 C282,464 270,486 246,480"/>
            <path class="tentacle" stroke-width="19" d="M268,250 C308,300 320,372 292,420 C278,446 292,476 266,476"/>
            <path class="tentacle" stroke-width="15" d="M300,236 C354,282 368,352 334,404 C316,432 328,468 300,470"/>
          </g>
          <ellipse cx="210" cy="168" rx="116" ry="110" fill="url(#body)"/>
          <ellipse cx="178" cy="108" rx="56" ry="34" fill="#fff" opacity=".10"/>
          <ellipse cx="170" cy="152" rx="31" ry="33" fill="#fff"/>
          <ellipse cx="250" cy="152" rx="31" ry="33" fill="#fff"/>
          <g class="pupil" id="pupL">
            <circle cx="170" cy="159" r="13" fill="#0b0b12"/>
            <circle cx="165" cy="154" r="4" fill="#fff" opacity=".9"/>
          </g>
          <g class="pupil" id="pupR">
            <circle cx="250" cy="159" r="13" fill="#0b0b12"/>
            <circle cx="245" cy="154" r="4" fill="#fff" opacity=".9"/>
          </g>
          <path d="M136,110 L196,134" stroke="#4d0a28" stroke-width="15" stroke-linecap="round"/>
          <path d="M284,110 L224,134" stroke="#4d0a28" stroke-width="15" stroke-linecap="round"/>
          <path d="M186,208 Q210,190 234,208" fill="none" stroke="#4d0a28" stroke-width="9" stroke-linecap="round"/>
          <path d="M201,198 L209,198 L205,210 Z" fill="#fff"/>
          <path d="M213,198 L221,198 L217,210 Z" fill="#fff"/>
        </svg>
      </div>
    </div>
    {{ACTION}}
    <div class="quick-links">{{QUICK_LINKS}}</div>
    <div class="brand">octopool</div>
  </main>
  <script>
    (function () {
      var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      var tilt = document.getElementById("tilt");
      var octo = document.getElementById("octo");
      var pl = document.getElementById("pupL");
      var pr = document.getElementById("pupR");
      function clamp(v) { return v < -1 ? -1 : v > 1 ? 1 : v; }
      function onMove(e) {
        var cx = clamp((e.clientX - innerWidth / 2) / (innerWidth / 2));
        var cy = clamp((e.clientY - innerHeight / 2) / (innerHeight / 2));
        if (!reduce) {
          tilt.style.transform = "rotate(" + cx * 4 + "deg) translate(" + cx * 10 + "px," + cy * 6 + "px)";
        }
        var t = "translate(" + cx * 9 + "px," + cy * 7 + "px)";
        pl.style.transform = t;
        pr.style.transform = t;
      }
      addEventListener("pointermove", onMove, { passive: true });
      octo.addEventListener("pointerdown", function () {
        octo.classList.remove("rage");
        void octo.offsetWidth;
        octo.classList.add("rage");
      });
      var copyButton = document.querySelector("[data-copy]");
      if (copyButton) {
        copyButton.addEventListener("click", function () {
          if (navigator.clipboard) {
            navigator.clipboard.writeText(copyButton.getAttribute("data-copy") || "").then(function () {
              copyButton.setAttribute("data-copied", "true");
              setTimeout(function () { copyButton.removeAttribute("data-copied"); }, 1100);
            }).catch(function () {});
          }
        });
      }
    })();
  </script>
</body>
</html>`;

const GITHUB_LOGIN_ACTION = `<a class="login" href="/login/github" rel="nofollow">
      <svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true">
        <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
      </svg>
      Sign in with GitHub
    </a>`;

const BREW_INSTALL_ACTION = `<div class="install-command">
      <span class="prompt">$</span>
      <code>${INSTALL_COMMAND}</code>
      <button class="copy-command" type="button" data-copy="${INSTALL_COMMAND}" aria-label="Copy install command" title="Copy">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M8 8V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2"/>
          <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 10a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>
        </svg>
      </button>
    </div>`;

const APP_LINKS = '<a href="/dashboard">Dashboard</a><a href="https://docs.octopool.dev/">Docs</a>';
const PUBLIC_LINKS =
  '<a href="https://docs.octopool.dev/">Docs</a><a href="https://github.com/openclaw/octopool">GitHub</a>';

function landingResponse(request: Request, env?: unknown): Response {
  const appSite = !isPublicRequest(request, env);
  return new Response(landingHTML(appSite), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      vary: "Accept",
    },
  });
}

export function rootResponse(request: Request, requestId: string, env?: unknown): Response {
  if (wantsJson(request)) {
    return jsonResponse({ ok: true, service: "octopool", request_id: requestId }, 200, {
      vary: "Accept",
    });
  }
  return landingResponse(request, env);
}

function landingHTML(appSite: boolean): string {
  return LANDING_HTML.replace("{{ACTION}}", appSite ? GITHUB_LOGIN_ACTION : BREW_INSTALL_ACTION)
    .replace("{{QUICK_LINKS}}", appSite ? APP_LINKS : PUBLIC_LINKS)
    .replace(
      '<meta property="og:url" content="https://octopool.dev/">',
      `<meta property="og:url" content="${appSite ? APP_ORIGIN : "https://octopool.dev"}/">`,
    );
}
