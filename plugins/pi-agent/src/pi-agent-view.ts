import { t, currentLocale, updateLocalizedMarkup } from "./i18n";
import type {
  PiManagementModel,
  PiManagementSession,
  PiManagementSessionDetail,
  PiManagementSettings,
  PiManagementSnapshot,
  PiManagementTurn,
} from "@reai/app-sdk/v1";

export interface PiAgentViewActions {
  onRefresh(): Promise<void>;
  onSelect(sessionId: string): Promise<PiManagementSessionDetail>;
  onSaveSettings(settings: PiManagementSettings): Promise<void>;
  onNavigate(page: "main" | "settings"): void;
}

export interface PiAgentView {
  refreshLocale(): void;
  update(
    snapshot: PiManagementSnapshot,
    models: { models: PiManagementModel[]; settings: PiManagementSettings; loggedIn: boolean },
  ): void;
  showSettings(): void;
  navigateRoot(): void;
  showError(error: unknown): void;
  destroy(): void;
}

type Page = "main" | "settings";
type Tab = "overview" | "config" | "activity";
type ModelPayload = { models: PiManagementModel[]; settings: PiManagementSettings; loggedIn: boolean };

const SIDEBAR_DEFAULT = 292;
const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 420;
const SIDEBAR_STORE_KEY = "reai.pi-agent.sidebar-width";

/** 协议用语 → 界面文案，与设计稿的 statusText 一一对应。 */
const statusText: Record<string, string> = {
  get idle() { return t("ui.m088"); },
  get queued() { return t("ui.m087"); },
  get preparing() { return t("ui.m086"); },
  get active() { return t("ui.m085"); },
};
const turnPriority: Record<string, number> = { active: 0, preparing: 1, queued: 2, idle: 3 };

/**
 * 协议状态没有 done / failed 两档，只有四个运行档位；这里把协议档映射到设计稿
 * 的三色 pill（running 高亮 + 圆点脉动 / queued 琥珀 / 其余中性）。协议里没有的
 * 失败态不造假——不会出现 failed 样式。
 */
const statusClass = (state: string): string =>
  state === "active" ? "running" : state === "queued" || state === "preparing" ? "queued" : "";

const esc = (value: unknown): string => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const appName = (appId: string): string => appId === "com.reai.device-doctor" ? t("ui.m084") :
  appId === "com.reai.voice" ? "Voice" : appId;

/* ---- 图标：path 与设计稿 ICONS 表逐字一致，描边参数也照搬 svgi() 的默认值 ---- */
const ICON_PATHS: Record<string, string> = {
  "shield-check":
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  mic: '<rect x="9" y="1" width="6" height="13" rx="3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="23" x2="12" y2="19"/>',
  keyboard:
    '<rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="10" x2="6" y2="10"/><line x1="10" y1="10" x2="10" y2="10"/><line x1="14" y1="10" x2="14" y2="10"/><line x1="18" y1="10" x2="18" y2="10"/><line x1="8" y1="14" x2="16" y2="14"/>',
  puzzle:
    '<path d="M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4a2 2 0 0 0-2 2v3.8h1.5a2.7 2.7 0 0 1 0 5.4H2V20a2 2 0 0 0 2 2h3.8v-1.5a2.7 2.7 0 0 1 5.4 0V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  "message-square":
    '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
  sparkles:
    '<path d="M12 3l1.9 5.8L19.7 10l-5.8 1.9L12 17.7l-1.9-5.8L4.3 10l5.8-1.9z"/><path d="M19 3l.7 2.1L21.8 6l-2.1.7L19 8.8l-.7-2.1L16.2 6l2.1-.7z"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5l-9.4 9.4a2.1 2.1 0 0 1-3-3z"/><path d="M14.7 6.3 18 3l3 3-3.3 3.3"/>',
  workflow: '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  "check-circle": '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
};

/** 设计稿 icon(n,s)：按名取 24×24 描边 SVG；认不出的名字返回空串。 */
const icon = (name: string, size: number): string => {
  const paths = ICON_PATHS[name];
  if (!paths) return "";
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"`
    + ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
};

const appIcon = (appId: string): string =>
  appId === "com.reai.voice" ? "mic"
    : appId === "com.reai.device-doctor" || appId === "com.reai.device-support" ? "keyboard" : "puzzle";

/* ---- 时间推导：全部从协议已有字段取值，不造字段 ---- */
const pad2 = (value: number): string => String(value).padStart(2, "0");
const fmtClock = (ms: number): string => {
  const date = new Date(ms);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};
const fmtDayClock = (ms: number): string => {
  const date = new Date(ms);
  return new Intl.DateTimeFormat(currentLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
};
const fmtDuration = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = pad2(total % 60);
  const minutes = Math.floor(total / 60) % 60;
  return total >= 3600
    ? `${Math.floor(total / 3600)}:${pad2(minutes)}:${seconds}`
    : `${pad2(minutes)}:${seconds}`;
};

export function mountPiAgentView(
  root: HTMLElement,
  initialSnapshot: PiManagementSnapshot,
  initialModels: ModelPayload,
  actions: PiAgentViewActions,
): PiAgentView {
  let snapshot = initialSnapshot;
  let models = initialModels;
  let page: Page = "main";
  let tab: Tab = "overview";
  let query = "";
  let selectedId = snapshot.sessions[0]?.sessionId;
  let error = "";
  let destroyed = false;

  /* 设计稿 paStatus：<span class="pa-status …"><i></i>{statusText}</span> */
  const statusPill = (state: string): string =>
    `<span class="pa-status ${statusClass(state)}"><i></i>${esc(statusText[state] ?? state)}</span>`;

  /* legacy 直连回合没有 logicalSessionId；把它们包装成独立会话而不是丢弃。 */
  const legacySessions = (): PiManagementSession[] => snapshot.turns
    .filter((turn) => !turn.logicalSessionId)
    .map((turn) => ({
      sessionId: `legacy:${turn.key}`,
      appId: turn.appId,
      appName: appName(turn.appId),
      title: turn.summary || t("ui.m082"),
      status: turn.state,
      temporary: turn.temporary,
      createdMs: turn.startedMs,
      updatedMs: turn.startedMs,
      model: models.settings.appOverrides[turn.appId] ?? models.settings.defaultModel,
      workspace: t("ui.m081"),
      directory: "pi-agent/sessions",
      systemPrompt: t("ui.m080"),
      skills: [],
      tools: [],
      mcp: [],
      memory: "session",
    }));

  const allSessions = (): PiManagementSession[] => [...legacySessions(), ...snapshot.sessions];
  const selected = (): PiManagementSession | undefined => {
    const sessions = allSessions();
    return sessions.find((item) => item.sessionId === selectedId) ?? sessions[0];
  };
  const topTurn = (sessionId: string): PiManagementTurn | undefined => snapshot.turns
    .filter((turn) => turn.logicalSessionId === sessionId)
    .sort((left, right) => turnPriority[left.state] - turnPriority[right.state])[0];

  /* 列表第二行「这一步在做什么」：优先用真实回合摘要，缺了按状态给中性描述。 */
  const taskLine = (session: PiManagementSession): string => {
    const turn = topTurn(session.sessionId);
    if (turn?.summary) return turn.summary;
    return session.status === "queued" ? t("ui.m079")
      : session.status === "preparing" ? t("ui.m078")
        : session.status === "active" ? t("ui.m077")
          : t("ui.m076");
  };

  /* 列表右侧时间：运行中是已进行时长、排队中排了多久、其余回看更新时间。 */
  const elapsedLabel = (session: PiManagementSession): string => {
    const turn = topTurn(session.sessionId);
    if (turn && turn.state !== "idle") {
      return `${turn.state === "active" ? t("ui.m075") : t("ui.m074")} ${fmtDuration(Date.now() - turn.startedMs)}`;
    }
    return fmtClock(session.updatedMs);
  };

  /* 「下一步」行动条文案：只做推导，不发明协议之外的承诺。 */
  const nextCopy = (session: PiManagementSession): string => {
    switch (session.status) {
      case "active": return t("ui.m073", { p0: session.appName });
      case "queued": return t("ui.m072");
      case "preparing": return t("ui.m071");
      default: return t("ui.m057");
    }
  };

  /* 设计稿 renderPaList：按插件分组；搜索把「显示数 / 总数」写进输入框右侧计数。 */
  const filteredSessions = (): { items: PiManagementSession[]; total: number } => {
    const sessions = allSessions();
    const normalized = query.trim().toLowerCase();
    const items = sessions.filter((item) => !normalized ||
      `${item.appName} ${item.title} ${taskLine(item)} ${item.directory}`.toLowerCase().includes(normalized));
    return { items, total: sessions.length };
  };

  const renderListHtml = (): string => {
    const groups = new Map<string, PiManagementSession[]>();
    for (const session of filteredSessions().items) {
      const list = groups.get(session.appName) ?? [];
      list.push(session);
      groups.set(session.appName, list);
    }
    if (!groups.size) return `<div class="pa-empty-list">${esc(t("ui.m069"))}<br>${esc(t("ui.m070"))}</div>`;
    return [...groups.entries()].map(([name, groupItems]) => `
      <div class="pa-group">
        <div class="pa-group-h"><span class="pa-group-ic">${icon(appIcon(groupItems[0].appId), 12)}</span>
          ${esc(name)}<em>${groupItems.length}</em></div>
        ${groupItems.map((item) => `
          <button class="pa-session${item.sessionId === selected()?.sessionId ? " active" : ""}"
            type="button" data-session="${esc(item.sessionId)}">
            <span class="pa-session-top"><span class="pa-session-name">${esc(item.title)}</span>${statusPill(item.status)}</span>
            <span class="pa-session-do">${esc(taskLine(item))}</span>
            <span class="pa-session-meta"><span>${item.temporary ? t("ui.m068") : ""}${esc(item.workspace)}</span><time>${esc(elapsedLabel(item))}</time></span>
          </button>`).join("")}
      </div>`).join("");
  };

  const syncListOnly = (): void => {
    const list = root.querySelector<HTMLElement>(".pa-list");
    if (!list) return;
    const { items, total } = filteredSessions();
    list.innerHTML = renderListHtml();
    const count = root.querySelector<HTMLElement>(".pa-count");
    if (count) count.textContent = `${items.length}/${total}`;
  };

  const renderOverview = (session: PiManagementSession): string => `
    <div class="pa-panel${tab === "overview" ? " active" : ""}" data-pa-panel="overview">
      <div class="pa-outcome">
        <div class="pa-outcome-k">${icon("activity", 13)}${esc(t("ui.m061"))}</div>
        <div class="pa-outcome-t">${esc(session.title)}</div>
        <div class="pa-outcome-s">${session.status === "active" ? t("ui.m060") :
          session.status === "preparing" ? t("ui.m059") :
          session.status === "queued" ? t("ui.m058") :
          t("ui.m057")}</div>
      </div>
      <div class="pa-next">${icon("check-circle", 14)}<span><b>${esc(t("ui.m062"))}</b> · ${esc(nextCopy(session))}</span></div>
      <div class="pa-card">
        <div class="pa-card-h">${icon("folder", 14)}${esc(t("ui.m063"))}</div>
        <dl class="pa-kv">
          <dt>${esc(t("ui.m064"))}</dt><dd>${esc(session.appName)}</dd>
          <dt>${esc(t("ui.m065"))}</dt><dd>${esc(session.model)}</dd>
          <dt>${esc(t("ui.m066"))}</dt><dd><b>${esc(session.workspace)}</b><br><code>${esc(session.directory)}</code></dd>
          <dt>${esc(t("ui.m067"))}</dt><dd>${esc(fmtDayClock(session.createdMs))}</dd>
        </dl>
      </div>
    </div>`;

  const renderConfig = (session: PiManagementSession): string => {
    const skills = session.skills ?? [];
    const tools = session.tools ?? [];
    return `<div class="pa-panel${tab === "config" ? " active" : ""}" data-pa-panel="config">
      <div class="pa-card" style="margin-top:0">
        <div class="pa-card-h">${icon("message-square", 14)}${esc(t("ui.m048"))}<small>System prompt</small></div>
        <div class="pa-prompt" id="paPrompt">${esc(session.systemPrompt ?? t("ui.m045"))}</div>
        ${session.systemPrompt === undefined ? "" : `<button class="pa-link" id="paPromptToggle" type="button">${esc(t("ui.m003"))}</button>`}
      </div>
      <div class="pa-card">
        <div class="pa-card-h">${icon("sparkles", 14)}${esc(t("ui.m049"))}<small>${esc(t("ui.m050", { p0: skills.length }))}</small></div>
        ${skills.length ? skills.map((skill) => `
          <div class="pa-skill"><span class="pa-skill-ic">${icon("sparkles", 13)}</span>
            <div class="pa-skill-b"><div class="pa-skill-t">${esc(skill.title)}</div>
              <div class="pa-skill-s">${esc(skill.id)} · ${esc(skill.digest)}</div></div></div>`).join("")
          : `<div class="pa-zero">${icon("sparkles", 15)}<span>${esc(t("ui.m046"))}</span></div>`}
        <div class="pa-footnote">${esc(t("ui.m051", { p0: session.appName }))}</div>
      </div>
      <div class="pa-card">
        <div class="pa-card-h">${icon("wrench", 14)}${esc(t("ui.m052"))}<small>${esc(t("ui.m050", { p0: tools.length }))}</small></div>
        <div class="pa-chips">${tools.length
          ? tools.map((tool) => `<span class="pa-chip">${icon("wrench", 11)}<b>${esc(tool)}</b></span>`).join("")
          : `<span class="pa-chip">${esc(t("ui.m047"))}</span>`}</div>
      </div>
      <div class="pa-card">
        <div class="pa-card-h">${icon("workflow", 14)}MCP</div>
        <dl class="pa-kv">
          <dt>${esc(t("ui.m053"))}</dt><dd>${esc(t("ui.m054"))}</dd>
          <dt>${esc(t("ui.m055"))}</dt><dd>${esc(t("ui.m056"))}</dd>
        </dl>
      </div>
    </div>`;
  };

  const renderActivity = (session: PiManagementSession): string => {
    const turn = topTurn(session.sessionId);
    return `<div class="pa-panel${tab === "activity" ? " active" : ""}" data-pa-panel="activity">
      <div class="pa-card" style="margin-top:0">
        <div class="pa-card-h">${icon("clock", 14)}${esc(t("ui.m040"))}<small>${esc(t("ui.m041", { p0: turn ? 2 : 1 }))}</small></div>
        <div class="pa-timeline">
          <div class="pa-event"><time>${esc(fmtClock(session.createdMs))}</time><span class="pa-event-mark"><i></i></span>
            <div><b>${esc(t("ui.m042"))}</b>${esc(t("ui.m043", { p0: session.appName }))}</div></div>
          ${turn ? `<div class="pa-event"><time>${esc(fmtClock(turn.startedMs))}</time><span class="pa-event-mark"><i></i></span>
            <div><b>${statusText[turn.state]} · ${esc(turn.summary)}</b></div></div>` : ""}
        </div>
      </div>
      <div class="pa-footnote">${esc(t("ui.m044"))}</div>
    </div>`;
  };

  const renderMainHtml = (): string => {
    const activeCount = allSessions().filter((item) => item.status === "active").length;
    const waitCount = allSessions().filter((item) => item.status === "queued" || item.status === "preparing").length;
    const runtimeOk = snapshot.runtime.state !== "failed";
    const widthCss = `${localStorage.getItem(SIDEBAR_STORE_KEY) ?? SIDEBAR_DEFAULT}px`;
    return `<div class="plugin-main-frame piagent-main-frame">
      <div class="main-body pa-layout">
        <aside class="pa-side" aria-label="${esc(t("ui.m033"))}" style="--pa-w:${widthCss}">
          <div class="pa-side-top">
            <div class="pa-title-row">
              <div>
                <div class="pa-title">${esc(t("ui.m036"))}</div>
                <div class="pa-side-sub">${esc(t("ui.m037", { p0: activeCount, p1: waitCount }))}</div>
              </div>
              <span class="pa-runtime-pill${runtimeOk ? "" : " bad"}"><i></i>${runtimeOk ? t("ui.m032") : t("ui.m031")}</span>
            </div>
            <div class="pa-scope">${icon("shield-check", 14)}<span>${esc(t("ui.m038"))}</span></div>
            <label class="pa-search" for="paSearch">${icon("search", 13)}
              <input id="paSearch" name="paSearch" placeholder="${esc(t("ui.m034"))}" autocomplete="off" value="${esc(query)}">
              <span class="pa-count"></span>
            </label>
            <p class="pa-isolation">${esc(t("ui.m039"))}</p>
          </div>
          <div class="pa-list"></div>
          <div class="rs-handle" role="separator" aria-orientation="vertical" tabindex="0"
            title="${esc(t("ui.m035"))}"></div>
        </aside>
        <section class="pa-main" aria-live="polite">${renderMainDetail()}</section>
      </div>
    </div>`;
  };

  const renderMainDetail = (): string => {
    const session = selected();
    if (!session) {
      return `<div class="pa-empty-detail"><h2>${esc(t("ui.m029"))}</h2><p>${esc(t("ui.m030"))}</p></div>`;
    }
    return `<header class="pa-head">
        <div class="pa-head-top"><div class="pa-head-b">
          <div class="pa-head-title">${esc(session.title)}</div>
          <div class="pa-head-meta">${statusPill(session.status)}<span class="pa-sep">·</span><span>${esc(session.appName)}</span></div>
        </div></div>
        <nav class="pa-tabs" aria-label="${esc(t("ui.m025"))}">
          <button class="pa-tab${tab === "overview" ? " active" : ""}" data-tab="overview" type="button">${esc(t("ui.m026"))}</button>
          <button class="pa-tab${tab === "config" ? " active" : ""}" data-tab="config" type="button">${esc(t("ui.m027"))}</button>
          <button class="pa-tab${tab === "activity" ? " active" : ""}" data-tab="activity" type="button">${esc(t("ui.m028"))}</button>
        </nav>
      </header>
      <div class="pa-detail">${renderOverview(session)}${renderConfig(session)}${renderActivity(session)}</div>`;
  };

  const modelMeta = (id: string): string => {
    const model = models.models.find((item) => item.id === id);
    if (!model) return "";
    return model.selectable && !model.verified ? t("ui.m024")
      : model.verified ? t("ui.m023") : t("ui.m022");
  };
  /* 设计稿把「实际生效」写成模型名（如 DeepSeek V3）；目录里没有的 id 原样回显。 */
  const modelLabel = (id: string): string => models.models.find((item) => item.id === id)?.label ?? id;
  const modelOptions = (value: string, inherit: boolean): string => {
    const options = inherit ? `<option value="inherit"${value === "inherit" ? " selected" : ""}>${esc(t("ui.m021"))}</option>` : "";
    return options + models.models.map((model) =>
      `<option value="${esc(model.id)}"${value === model.id ? " selected" : ""}${model.selectable ? "" : " disabled"}>`
      + `${esc(model.label)}${model.selectable ? "" : t("ui.m020")}</option>`).join("");
  };

  const renderSettingsHtml = (): string => {
    const appIds = [...new Set([
      "com.reai.device-doctor",
      "com.reai.voice",
      ...allSessions().map((item) => item.appId),
    ])];
    const appLabels = new Map(allSessions().map((item) => [item.appId, item.appName]));
    const chip = models.loggedIn
      ? `<span class="vs-chip ok">${esc(t("ui.m019", { p0: models.models.length }))}</span>`
      : `<span class="vs-chip warn">${esc(t("ui.m018"))}</span>`;
    const defaultModel = models.settings.defaultModel;
    const gate = models.loggedIn ? "" : " disabled";
    return `<div class="plugin-main-frame piagent-settings-frame">
      <div class="main-body voice-settings-body">
        <div class="voice-settings-intro">
          <div class="voice-settings-intro-copy">
            <div class="voice-settings-intro-title">${esc(t("ui.m009"))}</div>
            <div class="voice-settings-intro-sub">${esc(t("ui.m010"))}</div>
          </div>
          ${chip}
        </div>
        ${error ? `<div class="pas-error">${esc(error)}</div>` : ""}
        <div>
          <div class="slbl">${esc(t("ui.m011"))}</div>
          <div class="scard">
            <div class="row"><div class="rl">
                <div class="rt">${esc(t("ui.m012"))}</div>
                <div class="rs">${esc(t("ui.m013"))}</div>
              </div>
              <select class="pas-select" data-default aria-label="${esc(t("ui.m008"))}"${gate}>${modelOptions(defaultModel, false)}</select>
            </div>
            <div class="pas-model-note">${icon("sparkles", 14)}
              <span><b>${esc(modelLabel(defaultModel))}</b><br>${esc(modelMeta(defaultModel))}</span></div>
            <div class="vs-note"><b>${esc(t("ui.m014"))}</b>${esc(t("ui.m015"))}</div>
          </div>
        </div>
        <div>
          <div class="slbl">${esc(t("ui.m016"))}</div>
          <div class="scard">
            ${appIds.map((appId) => {
              const value = models.settings.appOverrides[appId] ?? "inherit";
              const effective = value === "inherit" ? defaultModel : value;
              return `<div class="pas-route"><div class="pas-route-app">
                  <span class="pas-route-ic">${icon(appIcon(appId), 14)}</span>
                  <div class="pas-route-copy"><div class="pas-route-name">${esc(appLabels.get(appId) ?? appName(appId))}</div>
                    <div class="pas-route-sub">${esc(t("ui.m006", { p0: appId, p1: modelLabel(effective) }))}</div></div>
                </div>
                <select class="pas-select" data-app="${esc(appId)}" aria-label="${esc(t("ui.m005", { p0: appLabels.get(appId) ?? appName(appId) }))}"${gate}>
                  ${modelOptions(value, true)}</select></div>`;
            }).join("")}
          </div>
          <div class="vs-note after-card">${esc(t("ui.m017"))}</div>
        </div>
        ${models.loggedIn ? "" : `<div class="pas-note">${esc(t("ui.m007"))}</div>`}
      </div>
    </div>`;
  };

  const bindMain = (): void => {
    syncListOnly();
    root.querySelector<HTMLInputElement>(".pa-search input")?.addEventListener("input", (event) => {
      query = (event.currentTarget as HTMLInputElement).value;
      syncListOnly();
    });
    root.querySelectorAll<HTMLElement>("[data-session]").forEach((button) => button.addEventListener("click", async () => {
      if (button.dataset.session) selectedId = button.dataset.session;
      render();
      const target = snapshot.sessions.find((item) => item.sessionId === selectedId);
      if (!target || target.systemPrompt !== undefined) return;
      try {
        const targetId = target.sessionId;
        const detail = await actions.onSelect(targetId);
        const current = snapshot.sessions.find((item) => item.sessionId === targetId);
        if (current) Object.assign(current, detail);
        if (selectedId === targetId) render();
      } catch (reason) {
        showError(reason);
      }
    }));
    /* 与设计稿一致：tab 只切面板可见性，不整页重渲染。 */
    root.querySelectorAll<HTMLElement>("[data-tab]").forEach((button) => button.addEventListener("click", () => {
      tab = button.dataset.tab as Tab;
      root.querySelectorAll<HTMLElement>("[data-tab]").forEach((item) =>
        item.classList.toggle("active", item === button));
      root.querySelectorAll<HTMLElement>("[data-pa-panel]").forEach((panel) =>
        panel.classList.toggle("active", panel.dataset.paPanel === tab));
    }));
    root.querySelector<HTMLElement>("#paPromptToggle")?.addEventListener("click", () => {
      const prompt = root.querySelector<HTMLElement>("#paPrompt");
      if (!prompt) return;
      prompt.classList.toggle("open");
      const toggle = root.querySelector<HTMLElement>("#paPromptToggle")!;
      toggle.textContent = prompt.classList.contains("open") ? t("ui.m004") : t("ui.m003");
    });
    bindResizer();
  };

  /* 分栏拖拽：照设计稿 makeResizer —— pointer capture，move/up 挂 document，
     松手才写盘；双击复位 292。捕获被收走时靠 lostpointercapture 兜底。 */
  const bindResizer = (): void => {
    const handle = root.querySelector<HTMLElement>(".rs-handle");
    const sidebar = root.querySelector<HTMLElement>(".pa-side");
    if (!handle || !sidebar) return;
    let pointerId: number | null = null;
    let startX = 0;
    let startWidth = 0;
    const clamp = (value: number): number => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(value)));
    const onMove = (event: PointerEvent): void => {
      if (pointerId === null || event.pointerId !== pointerId) return;
      sidebar.style.setProperty("--pa-w", `${clamp(startWidth + event.clientX - startX)}px`);
    };
    const stop = (event?: Event): void => {
      const pid = pointerId;
      if (pid === null) return;
      if (event && "pointerId" in event && (event as PointerEvent).pointerId !== pid) return;
      pointerId = null;
      try { handle.releasePointerCapture(pid); } catch { /* 捕获可能已被系统收走 */ }
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
      handle.classList.remove("dragging");
      /* 松手才落盘（拖拽途中不写 localStorage）。 */
      localStorage.setItem(SIDEBAR_STORE_KEY,
        clamp(parseFloat(sidebar.style.getPropertyValue("--pa-w")) || startWidth).toString());
    };
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      pointerId = event.pointerId;
      try { handle.setPointerCapture(pointerId); } catch { /* 部分 WebView 会拒绝；move 已挂 document */ }
      startX = event.clientX;
      startWidth = sidebar.getBoundingClientRect().width;
      handle.classList.add("dragging");
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", stop);
      document.addEventListener("pointercancel", stop);
    });
    handle.addEventListener("lostpointercapture", stop);
    handle.addEventListener("dblclick", () => {
      sidebar.style.setProperty("--pa-w", `${SIDEBAR_DEFAULT}px`);
      localStorage.setItem(SIDEBAR_STORE_KEY, String(SIDEBAR_DEFAULT));
    });
  };

  const bindSettings = (): void => {
    root.querySelectorAll<HTMLSelectElement>("select.pas-select").forEach((select) =>
      select.addEventListener("change", async () => {
        const next: PiManagementSettings = {
          defaultModel: root.querySelector<HTMLSelectElement>("[data-default]")?.value ?? models.settings.defaultModel,
          appOverrides: { ...models.settings.appOverrides },
        };
        root.querySelectorAll<HTMLSelectElement>("[data-app]").forEach((item) => {
          const id = item.dataset.app!;
          if (item.value === "inherit") delete next.appOverrides[id]; else next.appOverrides[id] = item.value;
        });
        try { error = ""; await actions.onSaveSettings(next); } catch (cause) { showError(cause); }
      }));
  };

  const render = (localeOnly = false): void => {
    if (destroyed) return;
    if (page === "settings") {
      if (localeOnly) updateLocalizedMarkup(root, renderSettingsHtml());
      else { root.innerHTML = renderSettingsHtml(); bindSettings(); }
      return;
    }
    if (localeOnly) {
      updateLocalizedMarkup(root, renderMainHtml());
      const list = root.querySelector<HTMLElement>(".pa-list");
      if (list) updateLocalizedMarkup(list, renderListHtml());
      const toggle = root.querySelector<HTMLElement>("#paPromptToggle");
      if (toggle) toggle.textContent = root.querySelector("#paPrompt")?.classList.contains("open") ? t("ui.m004") : t("ui.m003");
    } else { root.innerHTML = renderMainHtml(); bindMain(); }
  };

  const showError = (cause: unknown): void => {
    error = cause instanceof Error ? cause.message : String(cause);
    render();
  };

  render();
  return {
    refreshLocale() { render(true); },
    update(nextSnapshot, nextModels) {
      const details = new Map(snapshot.sessions
        .filter((item) => item.systemPrompt !== undefined)
        .map((item) => [item.sessionId, item]));
      nextSnapshot.sessions = nextSnapshot.sessions.map((item) => ({
        ...item,
        ...(details.get(item.sessionId) ? {
          systemPrompt: details.get(item.sessionId)?.systemPrompt,
          skills: details.get(item.sessionId)?.skills,
          tools: details.get(item.sessionId)?.tools,
          mcp: details.get(item.sessionId)?.mcp,
        } : {}),
      }));
      snapshot = nextSnapshot; models = nextModels;
      if (!selectedId) selectedId = allSessions()[0]?.sessionId;
      /* 输入法打字途中不要抢焦点：搜索框持焦时只刷新列表和计数。 */
      const search = root.querySelector<HTMLInputElement>(".pa-search input");
      if (!destroyed && page === "main" && search && root.ownerDocument.activeElement === search) syncListOnly();
      else render();
    },
    showSettings() { page = "settings"; actions.onNavigate("settings"); render(); },
    navigateRoot() { page = "main"; actions.onNavigate("main"); render(); },
    showError,
    destroy() { destroyed = true; root.replaceChildren(); },
  };
}
