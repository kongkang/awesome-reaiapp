// 网站只读公开目录；不传 Cookie、账号令牌或安装包信息。
export const CATALOG_URL = 'https://block2-api.wainao.chat/public/client-config?groups=appStore';
const assetOrigin = new URL(CATALOG_URL).origin;
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function publicAsset(value) {
  try { const url = new URL(value); return url.origin === assetOrigin && /^\/public\/app-store\/assets\/[a-zA-Z0-9-]+$/.test(url.pathname) ? url.href : null; }
  catch { return null; }
}
export function normalizePublicCatalog(data) {
  const store = data?.groups?.appStore;
  if (store?.schemaVersion !== 1 || !Array.isArray(store.apps) || store.apps.length > 1000) throw new Error('公开目录格式不支持');
  const ids = new Set();
  return store.apps.filter(a => a.reviewStatus === 'approved').map(a => {
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(a.appId) || ids.has(a.appId)) throw new Error('公开目录标识无效');
    ids.add(a.appId);
    if (typeof a.name !== 'string' || !a.name.trim() || typeof a.latestRelease?.version !== 'string') throw new Error('公开目录缺少名称或版本');
    const category = ({Dev:'developer',Agents:'agent',Productivity:'productivity',System:'system'})[a.category] ?? 'other';
    const label = ({developer:'开发工具',agent:'AI 与 Agent',productivity:'效率工具',system:'系统与设备',other:a.category || '其他'})[category];
    return { appId:a.appId, slug:a.appId.split('.').at(-1), name:a.name, version:a.latestRelease.version,
      developerName:a.developerName || '开发者', official:a.official === true,
      description: typeof a.tagline === 'string' && a.tagline.trim() ? a.tagline : String(a.description ?? '').split('\n')[0],
      longDescription:String(a.description ?? ''), category,label,icon:publicAsset(a.iconUrl),
      screenshots:(Array.isArray(a.screenshots) ? a.screenshots : []).flatMap(s => {const url=publicAsset(s.url);return url?[{url,caption:String(s.caption ?? '')}]:[];}),
      status:'published', source:'public-catalog', changelog:[] };
  });
}
export async function fetchPublicCatalog({fetchImpl=fetch,signal=AbortSignal.timeout(8000)}={}) {
  const response = await fetchImpl(CATALOG_URL,{credentials:'omit',headers:{Accept:'application/json'},signal});
  if (!response.ok) throw new Error(`公开目录暂时不可用 (${response.status})`);
  return normalizePublicCatalog(await response.json());
}
export function publicDetail(p) {
  const e=escapeHtml;
  if (!p) return '<div class="empty-state"><h1>此插件暂未在公开目录中收录。</h1><p>你可以继续探索已发布的插件。</p><a class="button secondary" href="/apps/">查看公开目录 →</a></div>';
  const logs=`/apps/${encodeURIComponent(p.appId)}/changelog/?version=${encodeURIComponent(p.version)}`;
  return `<div class="app-layout"><div><div class="app-heading">${p.icon?`<img src="${e(p.icon)}" width="80" height="80" alt="">`:'<span class="plugin-icon-placeholder" aria-hidden="true">＋</span>'}<div><p class="eyebrow">${e(p.label)}</p><h1 data-source-text>${e(p.name)}</h1><p class="app-id">${e(p.appId)}</p></div></div><p class="app-tagline" data-source-text>${e(p.description)}</p><section class="content-block"><p class="eyebrow">OVERVIEW</p><h2>关于这个插件</h2><p class="publisher-language-note">以下为发布者提供的原文介绍。</p><p class="body-copy public-description" data-source-text>${e(p.longDescription)}</p></section>${p.screenshots.length?`<section class="content-block"><h2>界面预览</h2><div class="public-screenshots">${p.screenshots.map(s=>`<figure><img src="${e(s.url)}" loading="lazy" alt="${e(s.caption || `${p.name}界面预览`)}">${s.caption?`<figcaption data-source-text>${e(s.caption)}</figcaption>`:''}</figure>`).join('')}</div></section>`:''}</div><aside class="app-facts"><p class="eyebrow">PLUGIN INFORMATION</p><dl><dt>开发者</dt><dd data-source-text>${e(p.developerName)}</dd><dt>公开版本</dt><dd><a href="${logs}">${e(p.version)} ↗</a></dd><dt>分类</dt><dd>${e(p.label)}</dd><dt>状态</dt><dd><span class="status-pill">已发布</span></dd></dl><a class="button secondary" href="${logs}">查看更新日志 →</a></aside></div>`;
}
