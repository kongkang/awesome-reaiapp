// Shared, dependency-free resources for static rendering and browser interactions.
const rows = [
 ['nav.download','下载','Download'],
 ['site.title','ReAI Open · 让能力连接更多可能','ReAI Open · Connect ideas with possibilities'],
 ['site.description','ReAI Open 开放平台：发现插件、探索应用案例、阅读文档并开始开发。','Discover ReAI plugins, explore practical scenarios, and build your next tool.'],
 ['site.skip','跳到主要内容','Skip to main content'],
 ['site.banner','ReAI Open · 开放插件、文档与应用场景','ReAI Open · Plugins, documentation, and practical scenarios'],
 ['site.homeLabel','ReAI Open 首页','ReAI Open home'],
 ['site.navLabel','主导航','Main navigation'],
 ['nav.apps','插件','Plugins'],['nav.cases','应用案例','Use cases'],['nav.builders','开发者','Developers'],['nav.docs','文档','Docs'],['nav.caseShort','案例','Cases'],['nav.build','开始构建','Start building'],
 ['hero.line1','让 AI 的能力，','Bring AI capabilities'],['hero.line2','走进每一种','into every kind of '],['hero.accent','工作。','work.'],
 ['hero.description1','发现好用的插件，探索真实的应用方式。','Discover useful plugins and practical ways to use them.'],
 ['hero.description2','也把你的想法，构建成下一个可用的工具。','Turn your next idea into a tool people can use.'],
 ['hero.explore','探索插件','Explore plugins'],['hero.develop','开发你的插件','Build your plugin'],
 ['hero.note','独立插件 · 开放能力 · 更多工作方式','Independent plugins · Open capabilities · New ways to work'],
 ['hero.artLabel','语音、浏览器和终端组成的能力演示，非真实插件截图','A concept illustration of voice, browser, and terminal tools; not a product screenshot'],
 ['hero.code','✓ 一点想法，无限可能。','✓ Small ideas. New possibilities.'],['hero.voice','语音输入法','Voice input'],
 ['hero.voiceText','说出想法，让文字落进工作。','Speak an idea. Put it to work.'],['hero.voiceBottom','从声音到行动','From voice to action'],['hero.browserText','连接网页与灵感。','Connect the web with ideas.'],
 ['principle.daily','为日常工作而造','Built for everyday work'],['principle.tools','用插件拓展你的工具箱','Expand your toolbox'],['principle.ideas','从灵感到应用','From ideas to tools'],
 ['discovery.title','找到你的下一件好工具。','Find your next useful tool.'],
 ['discovery.description','从语音输入到浏览器、终端，让每一步工作都有合适的能力。','From voice input to browsing and terminals, find the right capability for each step.'],
 ['discovery.all','浏览全部插件','Browse all plugins'],['discovery.filterLabel','按类别筛选插件','Filter plugins by category'],['discovery.allFilter','全部','All'],
 ['category.productivity','效率工具','Productivity'],['category.agent','AI 与 Agent','AI & Agents'],['category.developer','开发工具','Developer tools'],['category.system','系统与设备','System & devices'],['category.other','其他','Other'],
 ['discovery.search','搜索插件与能力','Search plugins and capabilities'],['discovery.view','查看介绍','View details'],['discovery.empty','没有找到匹配的插件。试试其他关键词或分类。','No matching plugins. Try another keyword or category.'],
 ['discovery.pluginSingular','插件','plugin'],['discovery.featuredSingular','精选插件','featured plugin'],
 ['discovery.count','展示 {count} 个{kind} · {state}','Showing {count} {kind} · {state}'],['discovery.plugins','插件','plugins'],['discovery.featured','精选插件','featured plugins'],
 ['catalog.snapshot','公开目录快照','Public catalog snapshot'],['catalog.updated','公开目录 · 已更新','Public catalog · Updated'],['catalog.failed','暂时无法刷新，显示最近一次公开目录快照','Refresh unavailable; showing the last public catalog snapshot'],['catalog.loading','正在读取公开目录','Loading the public catalog'],
 ['showcase.title1','能力连接起来，','Connect capabilities.'],['showcase.title2','工作就有了新方式。','Find new ways to work.'],['showcase.intro1','从一个具体任务出发，','Start with a specific task.'],['showcase.intro2','探索插件可以怎样一起工作。','Explore how plugins can work together.'],
 ['showcase.note','灵感笔记','Idea notes'],['showcase.paper1','把刚才的想法','Turn a fresh idea'],['showcase.paper2','变成下一步行动。','into your next action.'],['showcase.flow','语音 → 文字 → 编辑','Voice → Text → Edit'],
 ['showcase.writingCategory','内容创作','Content creation'],['showcase.writingLabel','内容创作 · 场景示例','Content creation · Example scenario'],['showcase.writingTitle','说出来，再把它打磨好。','Speak it. Then make it yours.'],['showcase.writingDescription','语音输入与文本编辑，让灵感从声音变成文字。','Capture ideas with your voice, then shape them in an editor.'],
 ['showcase.web','网页','Web'],['showcase.action','行动','Action'],['showcase.researchCategory','研究与开发','Research & development'],['showcase.researchLabel','研究与开发 · 场景示例','Research & development · Example scenario'],['showcase.researchTitle','让发现，成为下一步。','Turn discoveries into next steps.'],['showcase.researchDescription','从网页获取信息，用 Agent 辅助理解与构建。','Explore the web and use agents to help understand and build.'],
 ['builders.title1','下一个好工具，','The next useful tool'],['builders.title2','可以由你来构建。','can be yours to build.'],['builders.description1','从开发规范到接口与审核提交，','From specifications and APIs to review and release,'],['builders.description2','把一个想法带进 ReAI 的插件生态。','bring your idea into the ReAI plugin ecosystem.'],['builders.guide','阅读开发指南','Read the developer guide'],
 ['builders.docsStatus','开发文档已整合；原文档入口继续保留','Developer docs are integrated; the existing docs entry remains available'],
 ['builders.step1','从第一个插件开始','Build your first plugin'],['builders.summary1','项目结构、生命周期与最小权限','Project structure, lifecycle, and least privilege'],['builders.step2','连接平台能力','Connect platform capabilities'],['builders.summary2','SDK、接口合同与可复用服务','SDK, API contracts, and reusable services'],['builders.step3','准备审核与发布','Prepare for review and release'],['builders.summary3','独立打包、版本介绍与交付检查','Independent packaging, release notes, and delivery checks'],
 ['closing.explore','从这里，开始探索','Start exploring'],['footer.description','连接能力，也连接创造者。','Connecting capabilities and creators.'],['footer.copyright','© 2026 ReAI','© 2026 ReAI'],
 ['crumb.label','面包屑','Breadcrumb'],['crumb.home','首页','Home'],['directory.title','发现插件','Discover plugins'],['directory.line1','每一种工作，','For every kind of work,'],['directory.line2','都有新的可能。','there are new possibilities.'],['directory.intro','探索 ReAI 插件，用合适的能力完成下一步。','Explore ReAI plugins and find the capability for your next step.'],['directory.noscript','插件索引需要启用 JavaScript；具体插件页面仍可直接打开。','Enable JavaScript to browse the catalog. Individual plugin pages remain accessible.'],
 ['detail.overview','关于这个插件','About this plugin'],['detail.screenshots','界面预览','Interface previews'],['detail.version','公开版本','Published version'],['detail.category','分类','Category'],['detail.status','状态','Status'],['detail.published','已发布','Published'],['detail.logs','查看更新日志','View changelog'],['detail.notListed','此插件暂未在公开目录中收录。','This plugin is not currently listed in the public catalog.'],['detail.continue','你可以继续探索已发布的插件。','You can continue exploring published plugins.'],['detail.publicCatalog','查看公开目录','Browse the public catalog'],['detail.intro','插件介绍','Plugin details'],['detail.original','以下为发布者提供的原文介绍。','The following is the original description supplied by the publisher.'],
 ['log.title','更新日志','Changelog'],['log.intro','每一个版本，都应该有清楚的说明。','Every version deserves clear release notes.'],['log.search','查找具体版本','Find a specific version'],['log.view','查看版本','View version'],['log.current','你正在查看','You are viewing'],['log.unavailable','此插件尚未提供公开版本日志。','Public release notes are not available for this plugin yet.'],['log.pending','版本说明将在整理完成后展示。','Release notes will appear when they are available.'],['log.empty','更新日志还在准备中。','Release notes are being prepared.'],['log.emptyDescription','这里将记录每个版本的新功能、改进和修复。','This page will track features, improvements, and fixes for each version.'],['log.spec','了解版本文档规范','Read the release notes specification'],['log.missing','尚未收录此版本的更新日志。','Release notes for this version have not been collected yet.'],['log.notPublic','尚未公开','Not published'],['log.record','已找到该版本的源码文档记录；发布状态尚未核验。','Source documentation was found; its release status has not been verified.'],
 ['showcase.list1','好工具在一起，','Good tools, together.'],['showcase.listIntro','从一个任务出发，探索插件组合。以下为场景说明，尚未作为客户案例核验。','Explore combinations of plugins around a task. These are example scenarios, not verified customer case studies.'],['showcase.start','从哪里开始','Where to start'],['showcase.steps','一步一步，把想法接起来。','Connect your ideas, step by step.'],['showcase.outcome','预期结果与边界','Expected results and boundaries'],['showcase.tools','用到的插件','Plugins in this scenario'],['showcase.unavailable','部分场景工具尚未在公开目录中提供。','Some tools in this scenario are not yet available in the public catalog.'],['showcase.boundary','说明不代表自动化能力已经接通。实际使用以插件状态、权限及验证结果为准。','This description does not establish that automation is connected. Actual behavior depends on plugin status, permissions, and verified results.'],['showcase.all','全部应用案例','All use cases'],
 ['builders.full1','你的下一个想法，','Your next idea'],['builders.full2','可以成为一件好工具。','can become a useful tool.'],['builders.fullIntro','用独立插件接入 ReAI 的能力，从本机验证开始，逐步走向审核与发布。','Connect to ReAI through an independent plugin. Start with local validation, then prepare for review and release.'],['builders.start','开始开发','Start developing'],['builders.resources','从这里开始构建。','Start building here.'],['builders.allDocs','全部开发文档','All developer docs'],['builders.independent','版本独立，交付清楚。','Independent versions. Clear delivery.'],['builders.contract','稳定 appId、最小权限、可重放构建和真实验证，让插件能独立迭代。官方插件同样遵循正式审核要求。','Stable app IDs, least privilege, reproducible builds, and real validation let plugins evolve independently. Official plugins follow the same review requirements.'],['builders.settings','设置页、版本与关于入口','Settings, versions, and About links'],['builders.i18n','中英文语言包规范','Chinese and English language packs'],['builders.lifecycle','插件生命周期','Plugin lifecycle'],['builders.existing','探索已有插件','Explore existing plugins'],['builders.docsNote','开发文档已在此站提供，原文档入口继续可用：','Developer docs are available here. The existing entry remains accessible:'],
 ['builders.path1','项目骨架、生命周期与能力边界。','Project scaffolding, lifecycle, and capability boundaries.'],['builders.path2','SDK、Manifest 和接口合同。','SDK, Manifest, and API contracts.'],['builders.path3','做出一致的体验','Create a consistent experience'],['builders.path3Summary','界面、主题、语言与设置页规范。','UI, themes, languages, and settings specifications.'],['builders.path4','身份核对、独立打包与版本介绍。','Identity checks, independent packaging, and release notes.'],
 ['error.title','页面未找到','Page not found'],['error.heading','这个页面还没有找到。','We could not find this page.'],['error.intro','链接可能已变化。你可以回到首页，或继续发现插件。','The link may have changed. Return home or keep exploring plugins.'],['error.home','返回首页','Return home'],
 ['case.example','场景示例','Example scenario'],['case.deviceCategory','设备与日常','Devices & everyday work'],['case.deviceTitle','遇到问题，先把状态看清。','When something fails, check its status first.'],['case.deviceDescription','从连接、权限和运行环境开始定位设备问题。','Start diagnosing devices with connections, permissions, and runtime conditions.'],['case.deviceHeadline','少一点猜测，多一点清楚。','Less guesswork. More clarity.'],
 ['case.writingDescription','用语音捕捉想法，在编辑器里整理成文。','Capture ideas with your voice and organize them in an editor.'],['case.writingHeadline','把刚才的想法，变成下一步行动。','Turn a fresh idea into your next action.'],['case.writingContext','想法往往在走动、讨论或查看资料时出现。这个场景展示如何先留下文字，再整理成一份可读的文档。','Ideas often arrive while walking, discussing, or reading. This scenario captures them first, then shapes them into a readable document.'],['case.writingStep1','在语音输入法中选择识别方式，核对当前权限和模型状态。','Choose a recognition mode in Voice input and check permissions and model availability.'],['case.writingStep2','在需要写入的应用中放好光标，口述想法并完成识别。','Place the cursor in your target app, dictate your idea, and complete recognition.'],['case.writingStep3','在文本编辑器中整理段落、补充细节并保存本地文件。','Organize paragraphs in an editor, add details, and save the local file.'],['case.writingOutcome','期望得到一份由你确认和整理的文字稿。插件间自动交接和效果仍需实际验证；这里不提供已验证的客户案例或效率数据。','The intended result is a draft you have checked and edited. Automated handoffs and outcomes still require validation; no verified customer or productivity claims are made here.'],
 ['case.researchDescription','围绕网页资料，把信息探索接到 Agent 工作中。','Connect web research with agent-assisted work.'],['case.researchHeadline','从一个问题，到下一步行动。','From a question to a next step.'],['case.researchContext','查阅技术资料时，浏览、理解和动手通常交替发生。这个场景用浏览器、Agent 和终端组织这三个环节。','Technical research moves between browsing, understanding, and hands-on work. This scenario organizes those steps with a browser, an agent, and a terminal.'],['case.researchStep1','通过浏览器查看相关资料，确认来源和任务范围。','Browse relevant materials and confirm their sources and the task scope.'],['case.researchStep2','在 Agent 任务中提供你确认过的材料与明确目标；按要求完成授权。','Give the agent checked materials and a clear goal. Complete any required authorization.'],['case.researchStep3','在终端或对应工具中检查输出，验证后再采用修改。','Check the output in the terminal or relevant tool, and validate changes before adopting them.'],['case.researchOutcome','期望得到有来源、有边界、可验证的下一步方案。跨插件数据传递与自动执行需按实际合同验收；本页是场景说明。','The intended result is a sourced, scoped, and verifiable next-step plan. Cross-plugin transfers and automation must be validated against actual contracts. This page describes a scenario.'],
 ['case.deviceContext','设备没有按预期工作时，先辨认是连接、权限还是版本问题。诊断工具把本机状态整理成可行动的信息。','When a device behaves unexpectedly, distinguish connection, permission, and version issues first. Diagnostic tools organize local status into actionable information.'],['case.deviceStep1','打开设备诊断助手，查看连接与系统权限提示。','Open Device Doctor and review connection and system permission information.'],['case.deviceStep2','根据需要查看脱敏日志摘要；涉及云端分析时先确认授权。','Review redacted log summaries as needed. Confirm authorization before cloud analysis.'],['case.deviceStep3','依照诊断结果处理具体问题，再复核设备状态。','Address the specific issue indicated by the diagnosis, then check the device again.'],['case.deviceOutcome','期望得到清晰的故障方向和下一步操作。页面中的说明来自插件声明，未模拟诊断成功或证明具体设备已修好。','The intended result is a clear diagnosis direction and next action. This description follows plugin declarations; it does not simulate a successful diagnosis or establish that a device is repaired.'],
];
export const messages = Object.fromEntries(['zh','en'].map((locale,i)=>[locale,Object.fromEntries(rows.map(([key,...texts])=>[key,texts[i]]))]));
const sourceKeys = new Map();
for(const [key,zh] of rows) if(!sourceKeys.has(zh)) sourceKeys.set(zh,key);
export const localeFromPath = path => /^\/(?:en(?:\/|$)|docs\/en(?:\/|$))/.test(path) ? 'en' : 'zh';
export function t(key, values={}, locale='zh') {
 const text=messages[locale]?.[key] ?? messages.zh[key];
 if(text===undefined) throw new Error(`Missing translation: ${key}`);
 return text.replace(/\{(\w+)\}/g,(_,name)=>String(values[name] ?? `{${name}}`));
}
export function translateText(text,locale='zh') {
 if(locale==='zh') return text;
 const trimmed=text.trim();
 if(trimmed.endsWith(' · ReAI Open')) return text.replace(trimmed,`${translateText(trimmed.slice(0,-12),locale)} · ReAI Open`);
 if(trimmed.startsWith('← 返回')) return text.replace(trimmed,`← Back to ${translateText(trimmed.slice(4),locale)}`);
 if(trimmed.endsWith(' 更新日志')) return text.replace(trimmed,`${translateText(trimmed.slice(0,-5),locale)} Changelog`);
 const key=sourceKeys.get(trimmed);
 if(key) return text.replace(trimmed,t(key,{},locale));
 const core=trimmed.replace(/^(?:←\s*)|(?:\s*[→↗])$/g,'');
 const coreKey=sourceKeys.get(core);
 if(coreKey) return text.replace(core,t(coreKey,{},locale));
 if(trimmed.endsWith(' · 场景示例')) return text.replace(trimmed,`${translateText(trimmed.slice(0,-7),locale)} · Example scenario`);
 if(trimmed.endsWith(' / 场景示例')) return text.replace(trimmed,`${translateText(trimmed.slice(0,-7),locale)} / Example scenario`);
 return text;
}
export function localizedPath(path,locale) {
 if(!path.startsWith('/') || path.startsWith('//') || /^\/(assets|docs\/assets)\//.test(path) || /\.(?:js|css|png|svg|json)(?:[?#]|$)/.test(path)) return path;
 let clean=path.replace(/^\/en(?=\/|$)/,'').replace(/^\/docs\/en(?=\/|$)/,'/docs') || '/';
 return locale==='en' ? (clean.startsWith('/docs') ? clean.replace(/^\/docs(?=\/|$)/,'/docs/en') : `/en${clean}`) : clean;
}
// Trusted generated markup only. Publisher content marked data-source-text is never translated.
export function localizeHtml(html,locale) {
 html=html.replaceAll('https://ai-board.reai.com/zh/download',`https://ai-board.reai.com/${locale}/download`);
 let protectedDepth=0;
 const stack=[];
 return html.split(/(<[^>]*>)/g).map(part=>{
  if(!part.startsWith('<')) return protectedDepth ? part : translateText(part,locale);
  const close=/^<\/(\w+)/.exec(part);
  if(close) {const was=stack.pop();if(was) protectedDepth--;return part;}
  const open=/^<(\w+)/.exec(part);
  if(open && !/^(?:meta|link|img|input|br|hr|source|area|wbr)$/i.test(open[1]) && !part.endsWith('/>')) {const protect=protectedDepth>0 || /data-source-text/.test(part) || /^(script|style)$/.test(open[1]);stack.push(protect);if(protect)protectedDepth++;}
  if(/^<html\b/.test(part)) part=part.replace(/lang="[^"]+"/,`lang="${locale==='en'?'en':'zh-CN'}"`);
  part=part.replace(/href="(\/[^\"]*)"/g,(_,url)=>`href="${localizedPath(url,locale)}"`);
  if(!protectedDepth) part=part.replace(/(aria-label|placeholder|content|title)="([^"]*)"/g,(_,name,value)=>`${name}="${translateText(value,locale)}"`);
  return part;
 }).join('');
}
export function languageSwitcher(path,locale) {
 const next=locale==='en'?'zh':'en';
 return `<a id="site-language" class="language-switch" data-language-switch="${next}" href="${localizedPath(path,next)}" hreflang="${next==='en'?'en':'zh-CN'}" lang="${next==='en'?'en':'zh-CN'}" aria-label="${next==='en'?'Switch to English':'切换到中文'}">${next==='en'?'English':'中文'}</a>`;
}
