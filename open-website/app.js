import {fetchPublicCatalog,publicDetail} from "/public-catalog.js";
import {t,localeFromPath,localizedPath,localizeHtml} from "/i18n.js";
const locale=localeFromPath(location.pathname);
const text=(key,values={})=>t(key,values,locale);
const appIdFromPath=()=>{const parts=location.pathname.split("/");return parts[parts.indexOf("apps")+1];};
function updateLanguageLinks(){document.querySelectorAll("[data-language-switch]").forEach(a=>{a.href=localizedPath(location.pathname+location.search+location.hash,a.dataset.languageSwitch);});}
updateLanguageLinks();
document.querySelectorAll("[data-language-switch]").forEach(a=>a.addEventListener("click",()=>{try{
  localStorage.setItem("reai-open.locale",a.dataset.languageSwitch);
  sessionStorage.setItem("reai-open.language-context",JSON.stringify({path:new URL(a.href).pathname,scroll:window.scrollY}));
}catch{}}));
try {
  const context=JSON.parse(sessionStorage.getItem("reai-open.language-context") || "null");
  if(context?.path===location.pathname) {
    sessionStorage.removeItem("reai-open.language-context");
    const restore=()=>requestAnimationFrame(()=>{window.scrollTo(0,context.scroll || 0);document.getElementById("site-language")?.focus({preventScroll:true});});
    if(document.readyState==="complete") restore(); else window.addEventListener("load",restore,{once:true});
  }
}catch{}
// 构建期公开快照用于首屏；每次打开匿名刷新公开目录。
let plugins = window.REAI_CATALOG ?? [];
let catalogState = text("catalog.snapshot");
const featuredSlugs = ['voice', 'browser', 'terminal', 'code-worker', 'agents-tasks', 'text-editor'];
const grid = document.querySelector('#plugin-grid');
const search = document.querySelector('#plugin-search');
const status = document.querySelector('#search-status');
let category = 'all';
const params = new URLSearchParams(location.search);
if (search) search.value = params.get('q') ?? '';
const filterIds = [...document.querySelectorAll('[data-filter]')].map(b => b.dataset.filter);
if (filterIds.includes(params.get('category'))) category = params.get('category');

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function renderPlugins() {
  if (!grid || !search) return;
  const query = search.value.trim().toLocaleLowerCase();
  let matches = plugins.filter(p => (category === 'all' || p.category === category) && `${p.name} ${p.appId} ${p.description} ${p.label} ${p.slug}`.toLocaleLowerCase().includes(query));
  if (!grid.hasAttribute('data-full-catalog') && !query && category === 'all') matches = [...featuredSlugs.map(slug => matches.find(p => p.slug === slug)).filter(Boolean),...matches.filter(p=>!featuredSlugs.includes(p.slug))].slice(0,6);
  grid.replaceChildren();
  for (const p of matches) {
    const card = node('a', 'plugin-card');
    card.href = localizedPath(`/apps/${encodeURIComponent(p.appId)}/`,locale);
    card.setAttribute('aria-label', locale==="en" ? `View ${p.name}` : `查看${p.name}`);
    const top = node('div', 'plugin-top');
    const img = p.icon ? node('img') : node('span','plugin-icon-placeholder','＋'); if(p.icon){img.src = p.icon; img.alt = ''; img.width = 42; img.height = 42;}
    const title = node('div'); title.append(node('h3', '', p.name), node('small', '', p.developerName));
    const arrow = node('span', 'card-arrow', '↗'); arrow.setAttribute('aria-hidden', 'true');
    top.append(img, title, arrow);
    const bottom = node('div', 'plugin-bottom'); bottom.append(node('span', 'tag', text(`category.${p.category}`)), node('span', '', `${text('discovery.view')} →`));
    card.append(top, node('p', '', p.description), bottom); grid.append(card);
  }
  if (!matches.length) grid.append(node('div', 'empty', text('discovery.empty')));
  if (status) status.textContent = text('discovery.count',{count:matches.length,kind:text(grid.hasAttribute('data-full-catalog')?(matches.length===1?'discovery.pluginSingular':'discovery.plugins'):(matches.length===1?'discovery.featuredSingular':'discovery.featured')),state:catalogState});
  document.querySelectorAll('[data-filter]').forEach(button => { const active = button.dataset.filter === category; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
}
function preserveFilters() {
  const url = new URL(location.href);
  if (search.value.trim()) url.searchParams.set('q', search.value.trim()); else url.searchParams.delete('q');
  if (category !== 'all') url.searchParams.set('category', category); else url.searchParams.delete('category');
  history.replaceState(null, '', url); updateLanguageLinks();
}
if (grid) {
  document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { category = button.dataset.filter; renderPlugins(); preserveFilters(); }));
  search.addEventListener('input', () => { renderPlugins(); preserveFilters(); });
  window.addEventListener('pageshow', renderPlugins);
  document.addEventListener('keydown', event => {
    if (event.key === '/' && !['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName) && !event.target.isContentEditable) {event.preventDefault(); search.focus();}
  });
  renderPlugins();
}
const versionResult = document.querySelector('.version-result');
if (versionResult) {
  const version = params.get('version') ?? versionResult.dataset.currentVersion;
  document.querySelector('#requested-version').textContent = version;
  document.querySelector('#version-query').value = version;
  const entries = [...document.querySelectorAll('[data-version]')];
  const entry = entries.find(item => item.dataset.version === version);
  document.querySelector('#version-message').textContent = text(entry ? 'log.record' : 'log.missing');
  if (entry) entry.classList.add('selected-release');
}

const detailRoot = document.querySelector('[data-public-app]');
const publicNotice = document.querySelector('[data-catalog-notice]');
const logRoot = document.querySelector('[data-public-log]');
function renderPublicDetail() {
  if (!detailRoot) return;
  const appId=detailRoot.dataset.publicApp || appIdFromPath();
  const p=plugins.find(item=>item.appId===appId);
  detailRoot.innerHTML=localizeHtml(publicDetail(p),locale);
  document.title=`${p?.name ?? text('detail.intro')} · ReAI Open`;
  if(publicNotice) publicNotice.textContent=catalogState;
}
function renderPublicLog() {
  if(!logRoot) return;
  const appId=logRoot.dataset.publicLog || appIdFromPath();
  const p=plugins.find(item=>item.appId===appId);
  document.querySelector('#public-log-title').textContent=`${p?.name ?? text('nav.apps')} ${text('log.title')}`;
  document.title=`${p?.name ?? text('nav.apps')} ${text('log.title')} · ReAI Open`;
  const version=params.get('version') ?? p?.version ?? '';
  document.querySelector('#requested-version').textContent=version || text('log.notPublic');
  document.querySelector('#version-query').value=version;
  if(!p) document.querySelector('#version-message').textContent=text('detail.notListed');
  const back=document.querySelector('#public-log-back');
  back.href=localizedPath(`/apps/${encodeURIComponent(appId)}/`,locale); back.textContent=locale==="en" ? `← Back to ${p?.name ?? text("detail.intro")}` : `← 返回${p?.name ?? text("detail.intro")}`;
}
renderPublicDetail(); renderPublicLog();
if(grid || detailRoot || logRoot) {
  fetchPublicCatalog().then(catalog=>{
    plugins=catalog; catalogState=text('catalog.updated'); renderPlugins(); renderPublicDetail(); renderPublicLog();
  }).catch(()=>{
    catalogState=text('catalog.failed'); renderPlugins(); renderPublicDetail(); renderPublicLog();
  });
}
