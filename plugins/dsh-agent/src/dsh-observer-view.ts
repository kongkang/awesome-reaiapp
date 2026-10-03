import { t, currentLocale, updateLocalizedMarkup } from "./i18n";
import type {
  DshObserverHistoryItem,
  DshObserverHistoryPage,
  DshObserverSession,
  DshObserverSessionDetail,
  DshObserverSettings,
  DshObserverSnapshot,
} from "@reai/app-sdk/v1";

export interface DshObserverViewActions {
  refresh(): Promise<void>;
  sessionDetail(sessionId: string): Promise<DshObserverSessionDetail>;
  historyPage(sessionId: string, cursor?: string, limit?: number): Promise<DshObserverHistoryPage>;
  settings(): Promise<DshObserverSettings>;
  updateSettings(modelAlias: string): Promise<DshObserverSettings>;
  onNavigate(page: "main" | "settings"): void;
}

export interface DshObserverView {
  refreshLocale(): void;
  update(snapshot: DshObserverSnapshot): void;
  showSettings(): Promise<void>;
  refreshSettings(): Promise<void>;
  navigateRoot(): void;
  showError(error: unknown): void;
  destroy(): void;
}

type GroupMode = "progress" | "source" | "workspace";
type DetailTab = "overview" | "conversation" | "capabilities";
type Page = "main" | "settings";

const esc = (value: unknown): string => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const statusLabel = (status: string): string => ({
  running: t("ui.m088"),
  queued: t("ui.m087"),
  failed: t("ui.m086"),
  cancelled: t("ui.m085"),
  stale: t("ui.m084"),
  orphan: t("ui.m083"),
  completed: t("ui.m082"),
  idle: t("ui.m081"),
}[status] ?? status);

const runtimeLabel = (state: string): string => ({
  available: t("ui.m040"),
  pending: t("ui.m080"),
  disabled: t("ui.m079"),
  incompatible: t("ui.m078"),
  missing: t("ui.m077"),
  unavailable: t("ui.m039"),
}[state] ?? state);

const formatTime = (value: number | null | undefined): string => value
  ? new Date(value).toLocaleString(currentLocale(), {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    })
  : "—";

const formatDuration = (value: number | null): string => {
  if (value === null) return "—";
  if (value < 1_000) return `${value} ms`;
  if (value < 60_000) return t("ui.m076", { p0: (value / 1_000).toFixed(1) });
  return t("ui.m075", { p0: Math.floor(value / 60_000), p1: Math.round((value % 60_000) / 1_000) });
};

const groupKey = (session: DshObserverSession, mode: GroupMode): string => {
  if (mode === "source") return session.source.appId || "unknown";
  if (mode === "workspace") return session.workspace || "unknown";
  if (["running", "queued"].includes(session.status)) return "active";
  if (["failed", "stale", "orphan"].includes(session.status)) return "attention";
  return "recent";
};

const grouped = (sessions: DshObserverSession[], mode: GroupMode) => {
  const buckets = new Map<string, DshObserverSession[]>();
  for (const session of sessions) {
    const key = groupKey(session, mode);
    buckets.set(key, [...(buckets.get(key) ?? []), session]);
  }
  const keys = mode === "progress"
    ? ["active", "attention", "recent"].filter((key) => buckets.has(key))
    : [...buckets.keys()].sort((a, b) => {
        const newest = (key: string) => Math.max(...(buckets.get(key) ?? []).map((item) => item.updatedMs));
        return newest(b) - newest(a);
      });
  return keys.map((key) => {
    const items = [...(buckets.get(key) ?? [])].sort((a, b) => b.updatedMs - a.updatedMs);
    const label = mode === "progress"
      ? ({ active: t("ui.m074"), attention: t("ui.m073"), recent: t("ui.m072") }[key] ?? key)
      : mode === "source"
        ? items[0]?.source.name || t("ui.m071")
        : key === "unknown" ? t("ui.m070") : key;
    return { key, label, items };
  });
};

const historyHtml = (item: DshObserverHistoryItem): string => {
  const time = formatTime(item.time_ms);
  if (item.kind === "user_message" || item.kind === "assistant_message") {
    const who = item.kind === "assistant_message"
      ? "DSH"
      : item.source === "user"
        ? t("ui.m069")
        : t("ui.m068", { p0: item.source || "host" });
    return `<article class="dsho-message ${item.kind}"><header><b>${esc(who)}</b><time>${esc(time)}</time></header><p>${esc(item.text)}</p></article>`;
  }
  if (item.kind === "tool_call") {
    return `<article class="dsho-event tool"><header><b>${esc(t("ui.m067", { p0: item.name }))}</b><time>${esc(time)}</time></header><pre>${esc(item.arguments)}</pre><small>${esc(item.status)}</small></article>`;
  }
  if (item.kind === "tool_result") {
    return `<article class="dsho-event tool-result"><header><b>${esc(t("ui.m066"))}</b><time>${esc(time)}</time></header><pre>${esc(item.error || item.content)}</pre><small>${esc(item.status)}</small></article>`;
  }
  return `<article class="dsho-event lifecycle"><header><b>${esc(item.event)}</b><time>${esc(time)}</time></header><p>${esc(item.summary || item.status)}</p></article>`;
};

export function mountDshObserverView(
  root: HTMLElement,
  initialSnapshot: DshObserverSnapshot,
  actions: DshObserverViewActions,
): DshObserverView {
  let snapshot = initialSnapshot;
  let page: Page = "main";
  let settings: DshObserverSettings | undefined;
  let settingsLoading = false;
  let settingsSaving = false;
  let settingsMessage = "";
  let selectedId = snapshot.sessions[0]?.sessionId;
  let mode: GroupMode = "progress";
  let tab: DetailTab = "overview";
  let detail: DshObserverSessionDetail | undefined;
  let history: DshObserverHistoryItem[] = [];
  let nextCursor: string | null = null;
  let loadingDetail = false;
  let loadingHistory = false;
  let error = "";
  let requestGeneration = 0;
  let destroyed = false;

  const captureFocus = (): { attribute: string; value: string | null } | undefined => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !root.contains(active)) return undefined;
    for (const attribute of [
      "data-group", "data-session", "data-tab", "data-load-more", "data-refresh", "data-retry",
      "data-default-model",
    ]) {
      if (active.hasAttribute(attribute)) return { attribute, value: active.getAttribute(attribute) };
    }
    return undefined;
  };

  const restoreFocus = (marker: { attribute: string; value: string | null } | undefined): void => {
    if (!marker) return;
    const next = [...root.querySelectorAll<HTMLElement>(`[${marker.attribute}]`)]
      .find((element) => element.getAttribute(marker.attribute) === marker.value);
    next?.focus({ preventScroll: true });
  };

  const selected = (): DshObserverSession | undefined =>
    snapshot.sessions.find((item) => item.sessionId === selectedId) ?? snapshot.sessions[0];

  const summary = (): string => {
    const active = snapshot.sessions.filter((item) => ["running", "queued"].includes(item.status)).length;
    return t("ui.m065", { p0: active, p1: snapshot.sessions.length });
  };

  const renderOverview = (session: DshObserverSession): string => {
    const outcome = session.outcome?.summary || session.outcome?.error || statusLabel(session.status);
    return `<div class="dsho-grid">
      <section class="dsho-card dsho-primary"><span>${esc(t("ui.m055"))}</span><h3>${esc(session.currentTask || session.title || t("ui.m052"))}</h3><p>${esc(t("ui.m056", { p0: statusLabel(session.status) }))}</p></section>
      <section class="dsho-card"><span>${esc(t("ui.m057"))}</span><h3>${esc(outcome)}</h3><p>${esc(session.nextAction.label)}</p></section>
      <section class="dsho-card"><span>${esc(t("ui.m058"))}</span><h3>${esc(formatDuration(session.durationMs))}</h3><p>${esc(t("ui.m059", { p0: formatTime(session.createdMs) }))}</p></section>
      <section class="dsho-card dsho-wide"><span>${esc(t("ui.m060"))}</span><dl>
        <dt>${esc(t("ui.m061"))}</dt><dd>${esc(session.source.name)}（${esc(session.source.appId || t("ui.m053"))}）</dd>
        <dt>${esc(t("ui.m005"))}</dt><dd><code>${esc(session.workspace)}</code></dd>
        <dt>${esc(t("ui.m062"))}</dt><dd>${esc(session.modelAlias || t("ui.m054"))}</dd>
        <dt>${esc(t("ui.m063"))}</dt><dd>${esc(t("ui.m064", { p0: session.sessionId, p1: session.turnCount }))}</dd>
      </dl></section>
    </div>`;
  };

  const renderConversation = (): string => {
    if (loadingHistory && history.length === 0) return `<div class="dsho-empty">${esc(t("ui.m051"))}</div>`;
    if (history.length === 0) return `<div class="dsho-empty">${esc(t("ui.m050"))}</div>`;
    return `<div class="dsho-history">${history.map(historyHtml).join("")}</div>
      ${nextCursor ? `<button class="dsho-more" data-load-more ${loadingHistory ? "disabled" : ""}>${loadingHistory ? t("ui.m049") : t("ui.m048")}</button>` : ""}`;
  };

  const renderCapabilities = (session: DshObserverSession): string => {
    if (loadingDetail && !detail) return `<div class="dsho-empty">${esc(t("ui.m047"))}</div>`;
    if (!detail || detail.sessionId !== session.sessionId) return `<div class="dsho-empty">${esc(t("ui.m046"))}</div>`;
    if (!detail.configurationKnown) return `<div class="dsho-card"><h3>${esc(t("ui.m044"))}</h3><p>${esc(t("ui.m045"))}</p></div>`;
    return `<div class="dsho-grid">
      <section class="dsho-card dsho-wide"><span>${esc(t("ui.m041"))}</span><h3>${detail.systemPromptConfigured ? t("ui.m035") : t("ui.m034")}</h3><p>${esc(t("ui.m042", { p0: detail.systemPromptChars ?? 0, p1: detail.systemPromptDigest || t("ui.m036") }))}</p></section>
      <section class="dsho-card"><span>Skills</span>${detail.skills.length ? detail.skills.map((skill) => `<p><b>${esc(skill.title)}</b><br><small>${esc(skill.id)} · ${esc(skill.digest || t("ui.m036"))}</small></p>`).join("") : `<p>${esc(t("ui.m037"))}</p>`}</section>
      <section class="dsho-card"><span>Tools</span>${detail.tools.length ? detail.tools.map((tool) => `<p><b>${esc(tool.id)}</b><br><small>${tool.available ? t("ui.m040") : esc(tool.reason || t("ui.m039"))} · ${esc(tool.permission)}</small></p>`).join("") : `<p>${esc(t("ui.m038"))}</p>`}</section>
      <section class="dsho-card dsho-wide"><span>${esc(t("ui.m043"))}</span><dl><dt>Profile</dt><dd>${esc(detail.diagnostics.profileVersion)}</dd><dt>DSH</dt><dd>${esc(detail.diagnostics.dshVersion)}</dd><dt>${esc(t("ui.m005"))}</dt><dd><code>${esc(detail.diagnostics.workspace)}</code></dd></dl></section>
    </div>`;
  };

  const renderSettings = (): string => {
    const modelOptions = settings?.options.map((option) => {
      const disabled = option.availability === "available" ? "" : " disabled";
      const selected = option.id === settings?.selectedModel ? " selected" : "";
      const suffix = option.availability === "available" ? "" : t("ui.m033");
      return `<option value="${esc(option.id)}"${selected}${disabled}>${esc(option.label)}${suffix}</option>`;
    }).join("") ?? "";
    const components = snapshot.runtime.components.length
      ? snapshot.runtime.components.map((component) => `<li><div><b>${esc(component.id)}</b><small>${esc(component.version)}</small></div><code>${esc(component.digest)}</code></li>`).join("")
      : `<li class="dsho-settings-empty">${esc(t("ui.m032"))}</li>`;
    return `<div class="plugin-main-frame dsho-shell dsho-settings-frame">
      <section class="dsho-settings main-body">
        <header><span class="dsho-eyebrow">DSH</span><h2>${esc(t("ui.m024"))}</h2><p>${esc(t("ui.m025"))}</p></header>
        ${error ? `<div class="dsho-error">${esc(error)}</div>` : ""}
        <div class="dsho-settings-grid">
          <section class="dsho-settings-card"><span>${esc(t("ui.m026"))}</span><h3>${esc(t("ui.m027"))}</h3>
            <select data-default-model aria-label="${esc(t("ui.m023"))}"${settingsLoading || settingsSaving || !settings ? " disabled" : ""}>${modelOptions}</select>
            <p><b>${esc(t("ui.m028"))}</b>${esc(t("ui.m029"))}</p>
            ${settingsLoading ? `<small>${esc(t("ui.m021"))}</small>` : settingsMessage ? `<small>${esc(t(settingsMessage))}</small>` : ""}
          </section>
          <section class="dsho-settings-card dsho-settings-components"><span>${esc(t("ui.m030"))}</span><h3>${esc(runtimeLabel(snapshot.runtime.state))}</h3>
            <p>DSH ${esc(snapshot.runtime.dshVersion || t("ui.m022"))} · Profile ${esc(snapshot.runtime.profileVersion || t("ui.m022"))}</p>
            <ul>${components}</ul>
            <p class="dsho-readonly-note">${esc(t("ui.m031"))}</p>
          </section>
        </div>
      </section>
    </div>`;
  };

  const render = (localeOnly = false): void => {
    if (destroyed) return;
    if (page === "settings") {
      if (localeOnly) updateLocalizedMarkup(root, renderSettings());
      else { root.innerHTML = renderSettings(); bind(); }
      return;
    }
    const mainScrollTop = root.querySelector<HTMLElement>(".dsho-main")?.scrollTop ?? 0;
    const listScrollTop = root.querySelector<HTMLElement>(".dsho-session-list")?.scrollTop ?? 0;
    const focused = captureFocus();
    const current = selected();
    const markup = `<div class="plugin-main-frame dsho-shell">
      <section class="dsho-layout main-body">
        <aside class="dsho-sidebar" aria-label="${esc(t("ui.m017"))}">
          <header><div><h2>${esc(t("ui.m019"))}</h2><p>${esc(summary())}</p></div><span class="dsho-runtime ${esc(snapshot.runtime.state)}"><i></i>${esc(runtimeLabel(snapshot.runtime.state))}</span></header>
          <div class="dsho-runtime-detail"><span>${esc(snapshot.runtime.detail)}</span><small>${esc(t("ui.m020"))}</small></div>
          <nav class="dsho-groups" aria-label="${esc(t("ui.m018"))}">${(["progress", "source", "workspace"] as GroupMode[]).map((value) => `<button data-group="${value}" class="${mode === value ? "active" : ""}">${value === "progress" ? t("ui.m007") : value === "source" ? t("ui.m006") : t("ui.m005")}</button>`).join("")}</nav>
          <div class="dsho-session-list">${snapshot.sessions.length ? grouped(snapshot.sessions, mode).map((group) => `<section><h3>${esc(group.label)} <em>${group.items.length}</em></h3>${group.items.map((session) => `<button data-session="${esc(session.sessionId)}" class="dsho-session ${session.sessionId === current?.sessionId ? "active" : ""}"><span><b>${esc(session.title || session.currentTask || t("ui.m009"))}</b><i class="${esc(session.status)}">${esc(statusLabel(session.status))}</i></span><small>${esc(t("ui.m010", { p0: session.source.name, p1: session.turnCount, p2: formatTime(session.updatedMs) }))}</small></button>`).join("")}</section>`).join("") : `<div class="dsho-empty">${esc(t("ui.m008"))}</div>`}</div>
        </aside>
        <main class="dsho-main" aria-live="polite">
          ${error ? `<div class="dsho-error">${esc(error)} <button data-retry>${esc(t("ui.m011"))}</button></div>` : ""}
          ${current ? `<header><div><span class="dsho-eyebrow">${esc(current.source.name)}</span><h2>${esc(current.title || current.currentTask || t("ui.m009"))}</h2></div></header>
          <nav class="dsho-tabs" aria-label="${esc(t("ui.m016"))}">${(["overview", "conversation", "capabilities"] as DetailTab[]).map((value) => `<button data-tab="${value}" class="${tab === value ? "active" : ""}">${value === "overview" ? t("ui.m015") : value === "conversation" ? t("ui.m014") : t("ui.m013")}</button>`).join("")}</nav>
          <section class="dsho-content">${tab === "overview" ? renderOverview(current) : tab === "conversation" ? renderConversation() : renderCapabilities(current)}</section>` : `<div class="dsho-empty dsho-empty-main">${esc(t("ui.m012"))}</div>`}
        </main>
      </section>
    </div>`;
    if (localeOnly) updateLocalizedMarkup(root, markup);
    else { root.innerHTML = markup; bind(); }
    const main = root.querySelector<HTMLElement>(".dsho-main");
    const list = root.querySelector<HTMLElement>(".dsho-session-list");
    if (main) main.scrollTop = mainScrollTop;
    if (list) list.scrollTop = listScrollTop;
    restoreFocus(focused);
  };

  const loadDetail = async (): Promise<void> => {
    const sessionId = selected()?.sessionId;
    if (!sessionId) return;
    const generation = ++requestGeneration;
    loadingDetail = true;
    render();
    try {
      const value = await actions.sessionDetail(sessionId);
      if (!destroyed && generation === requestGeneration && selected()?.sessionId === sessionId) {
        detail = value;
        error = "";
      }
    } catch (cause) {
      if (!destroyed && generation === requestGeneration) showError(cause);
    } finally {
      if (!destroyed && generation === requestGeneration) {
        loadingDetail = false;
        render();
      }
    }
  };

  const loadHistory = async (append = false): Promise<void> => {
    const sessionId = selected()?.sessionId;
    if (!sessionId) return;
    const generation = append ? requestGeneration : ++requestGeneration;
    loadingHistory = true;
    render();
    try {
      const page = await actions.historyPage(sessionId, append ? nextCursor ?? undefined : undefined, 50);
      if (!destroyed && generation === requestGeneration && selected()?.sessionId === sessionId) {
        history = append ? [...page.items, ...history] : page.items;
        nextCursor = page.nextCursor;
        error = "";
      }
    } catch (cause) {
      if (!destroyed && generation === requestGeneration) showError(cause);
    } finally {
      if (!destroyed && generation === requestGeneration) {
        loadingHistory = false;
        render();
      }
    }
  };

  const selectSession = (sessionId: string): void => {
    ++requestGeneration;
    selectedId = sessionId;
    detail = undefined;
    history = [];
    nextCursor = null;
    error = "";
    render();
    if (tab === "conversation") void loadHistory();
    if (tab === "capabilities") void loadDetail();
  };

  const showError = (cause: unknown): void => {
    error = cause instanceof Error ? cause.message : String(cause);
    render();
  };

  const refreshSettings = async (): Promise<void> => {
    settingsLoading = true;
    settingsMessage = "";
    render();
    try {
      settings = await actions.settings();
      error = "";
    } catch (cause) {
      showError(cause);
    } finally {
      settingsLoading = false;
      render();
    }
  };

  const bind = (): void => {
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-group]")) {
      button.onclick = () => { mode = button.dataset.group as GroupMode; render(); };
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-session]")) {
      button.onclick = () => selectSession(button.dataset.session ?? "");
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
      button.onclick = () => {
        tab = button.dataset.tab as DetailTab;
        render();
        if (tab === "conversation" && history.length === 0) void loadHistory();
        if (tab === "capabilities" && detail?.sessionId !== selected()?.sessionId) void loadDetail();
      };
    }
    root.querySelector<HTMLButtonElement>("[data-load-more]")?.addEventListener("click", () => void loadHistory(true));
    const refresh = () => void actions.refresh().catch(showError);
    root.querySelector<HTMLButtonElement>("[data-refresh]")?.addEventListener("click", refresh);
    root.querySelector<HTMLButtonElement>("[data-retry]")?.addEventListener("click", refresh);
    root.querySelector<HTMLSelectElement>("[data-default-model]")?.addEventListener("change", (event) => {
      const modelAlias = (event.currentTarget as HTMLSelectElement).value;
      settingsSaving = true;
      settingsMessage = "ui.m004";
      render();
      void actions.updateSettings(modelAlias).then((next) => {
        settings = next;
        settingsMessage = "ui.m003";
        error = "";
      }).catch(showError).finally(() => {
        settingsSaving = false;
        render();
      });
    });
  };

  render();
  return {
    refreshLocale() { render(true); },
    update(next) {
      const snapshotUnchanged = next.revision === snapshot.revision
        && JSON.stringify(next) === JSON.stringify(snapshot);
      const hadError = error !== "";
      snapshot = next;
      if (!snapshot.sessions.some((item) => item.sessionId === selectedId)) {
        selectSession(snapshot.sessions[0]?.sessionId ?? "");
        return;
      }
      error = "";
      if (snapshotUnchanged && !hadError) return;
      render();
    },
    async showSettings() {
      page = "settings";
      actions.onNavigate("settings");
      render();
      await refreshSettings();
    },
    refreshSettings,
    navigateRoot() {
      page = "main";
      actions.onNavigate("main");
      error = "";
      render();
      void actions.refresh().catch(showError);
    },
    showError,
    destroy() {
      destroyed = true;
      ++requestGeneration;
      root.innerHTML = "";
    },
  };
}
