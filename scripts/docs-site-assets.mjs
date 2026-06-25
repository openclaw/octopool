// Octopus-themed docs site assets for octopool. Dark-first to match octopool.dev.

export function css() {
  return `
:root{
  --ink:#15101a;
  --text:#3a3340;
  --muted:#7c7286;
  --subtle:#a99fb2;
  --bg:#f6f4f8;
  --paper:#ffffff;
  --accent:#d61f5c;
  --accent-soft:rgba(214,31,92,.10);
  --accent-strong:#b3154b;
  --line:#e7e2ec;
  --line-soft:#f0ecf4;
  --code-bg:#0b0a10;
  --code-fg:#f1e9ef;
  --code-inline-fg:#7a0f43;
  --code-border:#241a26;
  --shadow-card:0 6px 22px rgba(122,15,67,.12);
  --hl-keyword:#ff6ea0;
  --hl-string:#9ad59b;
  --hl-number:#f0a868;
  --hl-comment:#8b7f93;
  --hl-flag:#c79bff;
  --hl-meta:#ff8aa0;
  --hl-prompt:#9a8aa6;
}
:root[data-theme="dark"]{
  --ink:#ffffff;
  --text:#c9c0d2;
  --muted:#9088a0;
  --subtle:#6a6178;
  --bg:#07070b;
  --paper:#121019;
  --accent:#ff4d6d;
  --accent-soft:rgba(255,40,90,.16);
  --accent-strong:#ff7088;
  --line:#211c2c;
  --line-soft:#181421;
  --code-bg:#050409;
  --code-fg:#f1e9ef;
  --code-inline-fg:#ffb3c4;
  --code-border:#1d1726;
  --shadow-card:0 10px 40px rgba(0,0,0,.55);
  --hl-keyword:#ff7e9d;
  --hl-string:#a6e3a1;
  --hl-number:#f0a868;
  --hl-comment:#6f6580;
  --hl-flag:#c79bff;
  --hl-meta:#ff8aa0;
  --hl-prompt:#8a7e98;
}
:root{color-scheme:light}
:root[data-theme="dark"]{color-scheme:dark}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:24px}
body{margin:0;background:var(--bg);color:var(--text);font-family:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.65;overflow-x:hidden;-webkit-font-smoothing:antialiased;transition:background-color .18s,color .18s}
::selection{background:var(--accent);color:#fff}
a{color:var(--accent);text-decoration:none;transition:color .12s}
a:hover{text-decoration:underline;text-underline-offset:.2em}
.shell{display:grid;grid-template-columns:272px minmax(0,1fr);min-height:100vh}
.sidebar{position:sticky;top:0;height:100vh;overflow:auto;padding:24px 22px;background:var(--paper);border-right:1px solid var(--line);scrollbar-width:thin;scrollbar-color:var(--line) transparent;transition:background-color .18s,border-color .18s}
.sidebar::-webkit-scrollbar{width:6px}
.sidebar::-webkit-scrollbar-thumb{background:var(--line);border-radius:6px}
.sidebar-head{display:flex;align-items:center;gap:10px;margin-bottom:24px}
.brand{display:flex;align-items:center;gap:11px;color:var(--ink);text-decoration:none;flex:1;min-width:0}
.brand:hover{text-decoration:none}
.brand .mark{flex:0 0 30px;width:30px;height:30px;filter:drop-shadow(0 0 7px rgba(255,40,90,.5))}
.brand strong{display:block;font-size:1.08rem;line-height:1.1;font-weight:700;letter-spacing:-.01em;color:var(--ink)}
.brand small{display:block;color:var(--muted);font-size:.74rem;margin-top:3px;font-weight:400}
.theme-toggle{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:34px;height:34px;border-radius:8px;border:1px solid var(--line);background:var(--paper);color:var(--muted);cursor:pointer;padding:0;transition:border-color .15s,color .15s,transform .12s}
.theme-toggle:hover{border-color:var(--accent);color:var(--accent)}
.theme-toggle:active{transform:scale(.94)}
.theme-toggle svg{width:16px;height:16px;display:block}
.theme-icon-sun{display:none}
:root[data-theme="dark"] .theme-icon-sun{display:block}
:root[data-theme="dark"] .theme-icon-moon{display:none}
.search{display:block;margin:0 0 22px}
.search span{display:block;color:var(--muted);font-size:.7rem;font-weight:600;text-transform:uppercase;margin-bottom:7px}
.search input{width:100%;border:1px solid var(--line);background:var(--bg);border-radius:8px;padding:9px 12px;font:inherit;font-size:.9rem;color:var(--text);outline:none;transition:border-color .15s,box-shadow .15s}
.search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
nav section{margin:0 0 18px}
nav h2{font-size:.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:0 0 6px;font-weight:700}
.nav-link{display:block;color:var(--text);text-decoration:none;border-radius:6px;padding:5px 10px;margin:1px 0;font-size:.9rem;line-height:1.4;transition:background .12s,color .12s}
.nav-link:hover{background:var(--line-soft);color:var(--ink);text-decoration:none}
.nav-link.active{background:var(--accent-soft);color:var(--accent);font-weight:600}
main{min-width:0;padding:32px clamp(20px,4.5vw,56px) 80px;max-width:1180px;margin:0 auto;width:100%}
.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:22px;border-bottom:1px solid var(--line);padding:8px 0 22px;margin-bottom:8px;flex-wrap:wrap}
.hero-text{min-width:0;flex:1 1 320px}
.eyebrow{margin:0 0 8px;color:var(--accent);font-weight:700;text-transform:uppercase;letter-spacing:.05em;font-size:.7rem}
.hero h1{font-size:2.25rem;line-height:1.1;letter-spacing:-.02em;margin:0;font-weight:700;color:var(--ink)}
.hero-meta{display:flex;gap:8px;flex:0 0 auto;flex-wrap:wrap}
.repo,.edit,.btn-ghost{border:1px solid var(--line);color:var(--text);text-decoration:none;border-radius:7px;padding:6px 11px;font-weight:500;font-size:.83rem;background:var(--paper);transition:border-color .15s,color .15s}
.repo:hover,.edit:hover,.btn-ghost:hover{border-color:var(--accent);color:var(--accent);text-decoration:none}
.edit{color:var(--muted)}
.home-hero{position:relative;padding:18px 0 30px;margin-bottom:8px;border-bottom:1px solid var(--line)}
.home-hero .octo-glow{position:absolute;top:-30px;right:-40px;width:340px;height:340px;background:radial-gradient(circle,rgba(255,40,90,.18),rgba(255,40,90,.05) 40%,transparent 66%);filter:blur(6px);pointer-events:none;z-index:0}
.home-hero>*{position:relative;z-index:1}
.home-hero h1{font-size:3.1rem;line-height:1.04;letter-spacing:-.025em;margin:0 0 .35em;font-weight:700;color:var(--ink)}
.home-hero .lede{font-size:1.16rem;line-height:1.55;color:var(--text);margin:0 0 1.2em;max-width:62ch}
.home-cta{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:0 0 18px}
.home-cta .btn{display:inline-flex;align-items:center;gap:7px;border-radius:9px;padding:10px 17px;font-weight:600;font-size:.92rem;text-decoration:none;transition:background .15s,border-color .15s,color .15s,transform .12s,box-shadow .15s}
.home-cta .btn-primary{background:var(--accent);color:#fff;border:1px solid var(--accent)}
.home-cta .btn-primary:hover{background:var(--accent-strong);border-color:var(--accent-strong);text-decoration:none;transform:translateY(-1px);box-shadow:0 10px 26px var(--accent-soft)}
.home-cta .btn-ghost{padding:10px 17px}
.home-install{display:flex;align-items:center;gap:12px;background:var(--code-bg);color:var(--code-fg);border-radius:9px;padding:10px 10px 10px 16px;font:500 .9rem/1.2 "JetBrains Mono","SF Mono",ui-monospace,monospace;max-width:36em;border:1px solid var(--code-border)}
.home-install .prompt{color:var(--accent);user-select:none;flex:0 0 auto}
.home-install code{flex:1;background:transparent;border:0;color:var(--code-fg);font:inherit;padding:0;white-space:pre;overflow:hidden;text-overflow:ellipsis}
.home-install .copy{flex:0 0 auto;background:rgba(255,255,255,.08);color:var(--code-fg);border:1px solid rgba(255,255,255,.16);border-radius:6px;padding:5px 11px;font:500 .72rem/1 "Inter",sans-serif;cursor:pointer;transition:background .15s,border-color .15s}
.home-install .copy:hover{background:rgba(255,255,255,.16)}
.home-install .copy.copied{background:var(--accent);border-color:var(--accent)}
.home-services{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 18px}
.home-services span{display:inline-block;padding:3px 10px;border:1px solid var(--line);border-radius:999px;font-size:.78rem;color:var(--muted);background:var(--paper)}
.doc-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:48px;margin-top:24px}
.doc-grid-home{margin-top:8px}
@media(min-width:1180px){.doc-grid{grid-template-columns:minmax(0,72ch) 200px;justify-content:start}.doc-grid-home{grid-template-columns:minmax(0,78ch);justify-content:start}}
.doc{min-width:0;max-width:72ch;overflow-wrap:break-word}
.doc-home{max-width:78ch}
.doc h1{font-size:2.5rem;line-height:1.08;letter-spacing:-.02em;margin:0 0 .4em;font-weight:700;color:var(--ink)}
body:not(.home) .doc>h1:first-child{display:none}
.doc h2{font-size:1.45rem;line-height:1.2;margin:2em 0 .5em;font-weight:700;letter-spacing:-.01em;color:var(--ink);position:relative}
.doc h3{font-size:1.1rem;margin:1.7em 0 .35em;position:relative;font-weight:600;color:var(--ink)}
.doc h4{font-size:.98rem;margin:1.4em 0 .25em;color:var(--ink);position:relative;font-weight:600}
.doc h2:first-child,.doc h3:first-child,.doc h4:first-child{margin-top:.2em}
.doc :is(h2,h3,h4) .anchor{position:absolute;left:-1.05em;top:0;color:var(--subtle);opacity:0;text-decoration:none;font-weight:400;padding-right:.3em;transition:opacity .12s,color .12s}
.doc :is(h2,h3,h4):hover .anchor{opacity:.7}
.doc :is(h2,h3,h4) .anchor:hover{opacity:1;color:var(--accent);text-decoration:none}
.doc p{margin:0 0 1.05em}
.doc ul,.doc ol{padding-left:1.3rem;margin:0 0 1.15em}
.doc li{margin:.25em 0}
.doc li>p{margin:0 0 .4em}
.doc strong{font-weight:600;color:var(--ink)}
.doc em{font-style:italic}
.doc code{font-family:"JetBrains Mono","SF Mono",ui-monospace,monospace;font-size:.84em;background:var(--line-soft);border:1px solid var(--line);border-radius:5px;padding:.08em .35em;color:var(--code-inline-fg)}
.doc pre{position:relative;overflow:auto;background:var(--code-bg);color:var(--code-fg);border-radius:10px;padding:14px 18px;margin:1.3em 0;font-size:.85em;line-height:1.6;scrollbar-width:thin;scrollbar-color:#3a2c38 transparent;border:1px solid var(--code-border)}
.doc pre::-webkit-scrollbar{height:8px;width:8px}
.doc pre::-webkit-scrollbar-thumb{background:#3a2c38;border-radius:8px}
.doc pre code{display:block;background:transparent;border:0;color:inherit;padding:0;font-size:1em;white-space:pre}
.doc pre .copy{position:absolute;top:8px;right:8px;background:rgba(255,255,255,.06);color:var(--code-fg);border:1px solid rgba(255,255,255,.16);border-radius:6px;padding:3px 9px;font:500 .7rem/1 "Inter",sans-serif;cursor:pointer;opacity:0;transition:opacity .15s,background .15s,border-color .15s}
.doc pre:hover .copy,.doc pre .copy:focus{opacity:1}
.doc pre .copy:hover{background:rgba(255,255,255,.12)}
.doc pre .copy.copied{background:var(--accent);border-color:var(--accent);opacity:1}
.doc pre .hl-c{color:var(--hl-comment);font-style:italic}
.doc pre .hl-s{color:var(--hl-string)}
.doc pre .hl-n{color:var(--hl-number)}
.doc pre .hl-k{color:var(--hl-keyword);font-weight:600}
.doc pre .hl-f{color:var(--hl-flag)}
.doc pre .hl-m{color:var(--hl-meta);font-weight:600}
.doc pre .hl-p{color:var(--hl-prompt);user-select:none}
.doc pre .hl-cmd{color:var(--hl-keyword);font-weight:600}
.doc blockquote{margin:1.4em 0;padding:10px 16px;border-left:3px solid var(--accent);background:var(--accent-soft);border-radius:0 8px 8px 0;color:var(--text)}
.doc blockquote p:last-child{margin-bottom:0}
.doc table{width:100%;border-collapse:collapse;margin:1.2em 0;font-size:.92em}
.doc th,.doc td{border-bottom:1px solid var(--line);padding:9px 10px;text-align:left;vertical-align:top}
.doc th{font-weight:600;color:var(--ink);background:var(--line-soft)}
.doc hr{border:0;border-top:1px solid var(--line);margin:2.2em 0}
.toc{position:sticky;top:24px;align-self:start;font-size:.84rem;padding-left:14px;border-left:1px solid var(--line);max-height:calc(100vh - 48px);overflow:auto;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.toc::-webkit-scrollbar{width:5px}
.toc::-webkit-scrollbar-thumb{background:var(--line);border-radius:5px}
.toc h2{font-size:.66rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:0 0 10px;font-weight:700}
.toc a{display:block;color:var(--muted);text-decoration:none;padding:4px 0 4px 10px;line-height:1.35;border-left:2px solid transparent;margin-left:-12px;transition:color .12s,border-color .12s}
.toc a:hover{color:var(--ink);text-decoration:none}
.toc a.active{color:var(--accent);border-left-color:var(--accent);font-weight:500}
.toc-l3{padding-left:22px!important;font-size:.94em}
@media(max-width:1179px){.toc{display:none}}
.page-nav{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:48px;border-top:1px solid var(--line);padding-top:20px}
.page-nav>a{display:block;border:1px solid var(--line);background:var(--paper);border-radius:10px;padding:13px 16px;text-decoration:none;color:var(--text);transition:border-color .15s,transform .15s,box-shadow .15s}
.page-nav>a:hover{border-color:var(--accent);text-decoration:none;color:var(--ink);transform:translateY(-1px);box-shadow:var(--shadow-card)}
.page-nav small{display:block;color:var(--muted);font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px;font-weight:600}
.page-nav span{display:block;font-weight:600;line-height:1.3;color:var(--ink)}
.page-nav-prev{text-align:left}
.page-nav-next{text-align:right;grid-column:2}
.page-nav-prev:only-child{grid-column:1}
.nav-toggle{display:none;position:fixed;top:calc(14px + env(safe-area-inset-top, 0px));right:calc(14px + env(safe-area-inset-right, 0px));z-index:20;width:40px;height:40px;border-radius:9px;background:var(--paper);border:1px solid var(--line);color:var(--ink);cursor:pointer;padding:10px 9px;flex-direction:column;align-items:stretch;justify-content:space-between;box-shadow:var(--shadow-card)}
.nav-toggle span{display:block;width:100%;height:2px;flex:0 0 2px;background:currentColor;border-radius:2px;transition:transform .2s,opacity .2s}
.nav-toggle[aria-expanded="true"] span:nth-child(1){transform:translateY(8px) rotate(45deg)}
.nav-toggle[aria-expanded="true"] span:nth-child(2){opacity:0}
.nav-toggle[aria-expanded="true"] span:nth-child(3){transform:translateY(-8px) rotate(-45deg)}
@media(max-width:900px){
  .shell{display:block}
  .sidebar{position:fixed;inset:0 30% 0 0;max-width:320px;height:100vh;z-index:15;transform:translateX(-100%);transition:transform .25s ease;box-shadow:0 18px 40px rgba(0,0,0,.4);background:var(--paper);pointer-events:none}
  .sidebar.open{transform:translateX(0);pointer-events:auto}
  .nav-toggle{display:flex}
  main{padding:64px 18px 56px}
  .hero h1{font-size:1.8rem}
  .home-hero h1{font-size:2.35rem}
  .doc h1{font-size:2.05rem}
  .hero-meta{width:100%;justify-content:flex-start}
  .doc{padding:0}
  .doc-grid{margin-top:18px;gap:24px}
  .doc :is(h2,h3,h4) .anchor{display:none}
}
@media(max-width:520px){
  main{padding:60px 14px 48px}
  .doc pre{margin-left:-14px;margin-right:-14px;border-radius:0;border-left:0;border-right:0}
  .home-install{flex-wrap:wrap}
}
@media (prefers-reduced-motion:reduce){.home-hero .octo-glow{display:none}}
`;
}

export function js() {
  return `
const themeRoot=document.documentElement;
function applyTheme(mode){themeRoot.dataset.theme=mode;document.querySelectorAll('[data-theme-toggle]').forEach(b=>b.setAttribute('aria-pressed',mode==='dark'?'true':'false'))}
function storedTheme(){try{return localStorage.getItem('theme')}catch(e){return null}}
function persistTheme(mode){try{localStorage.setItem('theme',mode)}catch(e){}}
applyTheme(themeRoot.dataset.theme==='light'?'light':'dark');
document.querySelectorAll('[data-theme-toggle]').forEach(btn=>{btn.addEventListener('click',()=>{const next=themeRoot.dataset.theme==='dark'?'light':'dark';applyTheme(next);persistTheme(next)})});
const sidebar=document.querySelector('.sidebar');
const toggle=document.querySelector('.nav-toggle');
const mobileNav=window.matchMedia('(max-width: 900px)');
const sidebarFocusable='a[href],button,input,select,textarea,[tabindex]';
function setSidebarFocusable(enabled){
  sidebar?.querySelectorAll(sidebarFocusable).forEach((el)=>{
    if(enabled){
      if(el.dataset.sidebarTabindex!==undefined){
        if(el.dataset.sidebarTabindex)el.setAttribute('tabindex',el.dataset.sidebarTabindex);
        else el.removeAttribute('tabindex');
        delete el.dataset.sidebarTabindex;
      }
    }else if(el.dataset.sidebarTabindex===undefined){
      el.dataset.sidebarTabindex=el.getAttribute('tabindex')??'';
      el.setAttribute('tabindex','-1');
    }
  });
}
function setSidebarOpen(open){
  if(!sidebar||!toggle)return;
  sidebar.classList.toggle('open',open);
  toggle.setAttribute('aria-expanded',open?'true':'false');
  if(mobileNav.matches){
    sidebar.inert=!open;
    if(open)sidebar.removeAttribute('aria-hidden');
    else sidebar.setAttribute('aria-hidden','true');
    setSidebarFocusable(open);
  }else{
    sidebar.inert=false;
    sidebar.removeAttribute('aria-hidden');
    setSidebarFocusable(true);
  }
}
setSidebarOpen(false);
toggle?.addEventListener('click',()=>setSidebarOpen(!sidebar?.classList.contains('open')));
document.addEventListener('click',(e)=>{if(!sidebar?.classList.contains('open'))return;if(sidebar.contains(e.target)||toggle?.contains(e.target))return;setSidebarOpen(false)});
document.addEventListener('keydown',(e)=>{if(e.key==='Escape')setSidebarOpen(false)});
const syncSidebarForViewport=()=>setSidebarOpen(sidebar?.classList.contains('open')??false);
if(mobileNav.addEventListener)mobileNav.addEventListener('change',syncSidebarForViewport);
else mobileNav.addListener?.(syncSidebarForViewport);
const input=document.getElementById('doc-search');
input?.addEventListener('input',()=>{const q=input.value.trim().toLowerCase();document.querySelectorAll('nav section').forEach(sec=>{let any=false;sec.querySelectorAll('.nav-link').forEach(a=>{const m=!q||a.textContent.toLowerCase().includes(q);a.style.display=m?'block':'none';if(m)any=true});sec.style.display=any?'block':'none'})});
function attachCopy(target,getText){const btn=document.createElement('button');btn.type='button';btn.className='copy';btn.textContent='Copy';btn.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(getText());btn.textContent='Copied';btn.classList.add('copied');setTimeout(()=>{btn.textContent='Copy';btn.classList.remove('copied')},1400)}catch{btn.textContent='Failed';setTimeout(()=>{btn.textContent='Copy'},1400)}});target.appendChild(btn)}
document.querySelectorAll('.doc pre').forEach(pre=>attachCopy(pre,()=>pre.querySelector('code')?.textContent??''));
document.querySelectorAll('.home-install').forEach(el=>attachCopy(el,()=>el.querySelector('code')?.textContent??''));
const tocLinks=document.querySelectorAll('.toc a');
if(tocLinks.length){const map=new Map();tocLinks.forEach(a=>{const id=a.getAttribute('href').slice(1);const el=document.getElementById(id);if(el)map.set(el,a)});const setActive=l=>{tocLinks.forEach(x=>x.classList.remove('active'));l.classList.add('active')};const obs=new IntersectionObserver(entries=>{const visible=entries.filter(e=>e.isIntersecting).sort((a,b)=>a.boundingClientRect.top-b.boundingClientRect.top);if(visible.length){const link=map.get(visible[0].target);if(link)setActive(link)}},{rootMargin:'-15% 0px -65% 0px',threshold:0});map.forEach((_,el)=>obs.observe(el))}
`;
}

export function preThemeScript() {
  return `(function(){var s;try{s=localStorage.getItem('theme')}catch(e){}document.documentElement.dataset.theme=s==='light'?'light':'dark'})();`;
}

export function themeToggleHtml() {
  return `<button class="theme-toggle" type="button" aria-label="Toggle dark mode" aria-pressed="false" data-theme-toggle>
    <svg class="theme-icon-moon" viewBox="0 0 20 20" aria-hidden="true"><path d="M14.6 12.1A6.5 6.5 0 0 1 7.4 2.7a6.5 6.5 0 1 0 7.2 9.4z" fill="currentColor"/></svg>
    <svg class="theme-icon-sun" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.4" fill="currentColor"/><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="10" y1="2" x2="10" y2="4"/><line x1="10" y1="16" x2="10" y2="18"/><line x1="2" y1="10" x2="4" y2="10"/><line x1="16" y1="10" x2="18" y2="10"/><line x1="4.2" y1="4.2" x2="5.6" y2="5.6"/><line x1="14.4" y1="14.4" x2="15.8" y2="15.8"/><line x1="4.2" y1="15.8" x2="5.6" y2="14.4"/><line x1="14.4" y1="5.6" x2="15.8" y2="4.2"/></g></svg>
  </button>`;
}

// Compact angry-octopus mark, matching the octopool.dev landing octopus.
export function octoMarkSvg() {
  return `<svg class="mark" viewBox="0 0 420 500" role="img" aria-label="octopool" xmlns="http://www.w3.org/2000/svg">
<defs>
<linearGradient id="ob" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff4d6d"/><stop offset=".55" stop-color="#d61f5c"/><stop offset="1" stop-color="#7a0f43"/></linearGradient>
<linearGradient id="oa" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e21e5e"/><stop offset="1" stop-color="#5e0a36"/></linearGradient>
</defs>
<g fill="none" stroke="url(#oa)" stroke-linecap="round">
<path stroke-width="18" d="M152,250 C112,300 100,372 128,420 C142,446 128,476 154,476"/>
<path stroke-width="22" d="M203,262 C198,338 192,408 184,452 C180,476 196,488 210,480"/>
<path stroke-width="22" d="M217,262 C222,338 228,408 236,452 C240,476 224,488 210,480"/>
<path stroke-width="18" d="M268,250 C308,300 320,372 292,420 C278,446 292,476 266,476"/>
</g>
<ellipse cx="210" cy="168" rx="116" ry="110" fill="url(#ob)"/>
<ellipse cx="170" cy="152" rx="31" ry="33" fill="#fff"/>
<ellipse cx="250" cy="152" rx="31" ry="33" fill="#fff"/>
<circle cx="170" cy="159" r="13" fill="#0b0b12"/>
<circle cx="250" cy="159" r="13" fill="#0b0b12"/>
<path d="M136,110 L196,134" stroke="#4d0a28" stroke-width="15" stroke-linecap="round"/>
<path d="M284,110 L224,134" stroke="#4d0a28" stroke-width="15" stroke-linecap="round"/>
</svg>`;
}

// Angry-octopus tile favicon, matching docs/assets/favicon.svg (the rasterized source).
export function faviconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="octopool">
<defs>
<linearGradient id="fbg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#16111f"/><stop offset="1" stop-color="#07070b"/></linearGradient>
<linearGradient id="fbody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff5a78"/><stop offset=".55" stop-color="#d61f5c"/><stop offset="1" stop-color="#7a0f43"/></linearGradient>
<linearGradient id="farm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e21e5e"/><stop offset="1" stop-color="#5e0a36"/></linearGradient>
<radialGradient id="fglow" cx="50%" cy="44%" r="55%"><stop offset="0" stop-color="#ff285a" stop-opacity=".55"/><stop offset="55%" stop-color="#ff285a" stop-opacity=".12"/><stop offset="100%" stop-color="#ff285a" stop-opacity="0"/></radialGradient>
</defs>
<rect width="64" height="64" rx="14" fill="url(#fbg)"/>
<circle cx="32" cy="29" r="25" fill="url(#fglow)"/>
<g fill="none" stroke="url(#farm)" stroke-linecap="round">
<path stroke-width="4.4" d="M21 33 C15 41 14 49 18 55"/>
<path stroke-width="5.4" d="M27 36 C24 45 23 52 26 57"/>
<path stroke-width="5.4" d="M37 36 C40 45 41 52 38 57"/>
<path stroke-width="4.4" d="M43 33 C49 41 50 49 46 55"/>
</g>
<ellipse cx="32" cy="27" rx="19" ry="18" fill="url(#fbody)"/>
<ellipse cx="25.5" cy="26.5" rx="6.4" ry="6.8" fill="#fff"/>
<ellipse cx="38.5" cy="26.5" rx="6.4" ry="6.8" fill="#fff"/>
<circle cx="26.4" cy="28" r="2.8" fill="#0b0b12"/>
<circle cx="37.6" cy="28" r="2.8" fill="#0b0b12"/>
<circle cx="25.3" cy="26.7" r="1" fill="#fff"/>
<circle cx="36.5" cy="26.7" r="1" fill="#fff"/>
<path d="M16.5 16 L29 22.5" stroke="#4d0a28" stroke-width="3.4" stroke-linecap="round"/>
<path d="M47.5 16 L35 22.5" stroke="#4d0a28" stroke-width="3.4" stroke-linecap="round"/>
<path d="M29 35 Q32 32.4 35 35" fill="none" stroke="#4d0a28" stroke-width="2" stroke-linecap="round"/>
</svg>`;
}
