import { adminSnapshot, project, writeSchemas, ROLES, type Board, type Child, type Limits, type Role } from "./domain";
import { createI18n, updateLocalizedMarkup } from "./i18n";
import { icon, sprite } from "./icons";
import type { GatewayConnection } from "@reai/app-sdk/v1";
import { SKILL_CONTENT } from "./skill.generated";

export type Connection =
  | { state: "ready"; board: Board }
  | { state: "loading" | "unavailable" | "error" | "forbidden" };
export interface ViewOptions {
  locale: string;
  limits: Limits;
  connection: Connection;
  saveDefaults(limits: Limits): Promise<void>;
  retry(): Promise<void>;
  createAgent?(): Promise<GatewayConnection>;
  connectAgent?(id: string): Promise<GatewayConnection>;
  loadChild?(id: string): Promise<Child>;
  exportTask?(id: string): Promise<{ text: string; digest: string; revision: number }>;
  archiveTask?(id: string, revision: number, digest: string): Promise<boolean>;
  onNavigate(nav: { key: string; label: string } | null): void;
}
type Tab = "board" | "roles" | "api" | "skill";
const esc = (value: unknown) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/** Administrator UI only. Inspecting an Agent never assumes that Agent's identity. */
export function mountCodeWorker(root: HTMLElement, options: ViewOptions) {
  const i18n = createI18n(options.locale), t = i18n.t;
  let connection = options.connection, limits = { ...options.limits };
  let tab: Tab = "board", taskId: string | null = null, identity: string | null = null;
  let backup: { id: string; text: string; digest: string; revision: number } | undefined;
  let connectionText = "", detail: Child | undefined;
  let stopped = false, saving = false, skillSelected = false, formStatus: string | null = null;
  let returnFocus: HTMLElement | null = null;
  let dialog: { kind: "child" | "source"; id: string } | { kind: "limit"; role: Role } | { kind: "connection" } | { kind: "archive" } | null = null;
  const frame = root.ownerDocument.createElement("section"); frame.className = "cw-frame";
  frame.innerHTML = `${sprite()}<div class="cw-page"></div><div class="cw-overlay" hidden><div class="cw-dialog" role="dialog" aria-modal="true" tabindex="-1"></div></div>`;
  root.append(frame);
  const page = frame.querySelector<HTMLElement>(".cw-page")!;
  const overlay = frame.querySelector<HTMLElement>(".cw-overlay")!;
  const drawer = frame.querySelector<HTMLElement>(".cw-dialog")!;
  const board = () => connection.state === "ready" ? connection.board : undefined;
  const button = (label: string, attrs: string, name = "", primary = false) => `<button type="button" class="cw-btn${primary ? " primary" : ""}" ${attrs}>${name ? icon(name) : ""}${esc(label)}</button>`;
  const closeButton = () => `<button type="button" class="cw-close" data-close aria-label="${esc(t("common.close"))}">${icon("x")}</button>`;

  function statePanel(state: "loading" | "unavailable" | "error" | "forbidden") {
    const key = state === "unavailable" ? "detail" : `${state}Detail`;
    return `<div class="cw-state" role="status"${state === "loading" ? ' aria-busy="true"' : ""}>${icon(state === "error" ? "alert-circle" : state === "forbidden" ? "shield-check" : "activity")}<h2>${esc(t(`connection.${state}`))}</h2><p>${esc(t(`connection.${key}`))}</p>${state === "error" ? button(t("common.retry"), "data-retry") : ""}</div>`;
  }
  function columns(stages: string[], prefix: "root" | "child", contents: (stage: string) => { count: number; cards: string }) {
    return `<div class="cw-board${prefix === "root" ? " cw-root-board" : ""}" aria-label="${esc(t(prefix === "root" ? "board.label" : "board.childrenLabel"))}">${stages.map(stage => {
      const { count, cards } = contents(stage);
      return `<section class="cw-col" data-stage="${stage}"><div class="cw-col-head"><i class="cw-dot"></i>${esc(t(`${prefix}.${stage}`))}<span>${board() ? count : "—"}</span></div>${cards || `<div class="cw-empty-col">${esc(t(board() ? "board.empty" : "board.notConnected"))}</div>`}</section>`;
    }).join("")}</div>`;
  }
  function childCard(child: Child) {
    return `<button type="button" class="cw-card" data-child="${esc(child.id)}"><div class="cw-card-top">${esc(child.id)}</div><h3>${esc(child.title)}</h3><div class="cw-card-meta">Worker · ${esc(child.worker || t("child.waitingWorker"))}<br>Tester · ${esc(child.tester || t("child.waitingTester"))}</div><div class="cw-card-foot"><span>${esc(t(`child.${child.status}`))}</span><span>${esc(child.attempt ? t("child.attempt", { count: child.attempt }) : t("child.waiting"))}</span></div></button>`;
  }
  function taskBoard() {
    const data = board();
    if (!data) return statePanel(connection.state === "ready" ? "error" : connection.state) + (connection.state === "unavailable" ? columns(["queued", "running", "merging", "done"], "root", () => ({ count: 0, cards: "" })) : "");
    const d = adminSnapshot(data), task = d.tasks.find(t => t.id === taskId);
    if (task) {
      const children = d.children.filter(c => c.taskId === task.id);
      return button(t("tabs.board"), "data-home", "chevron-left") + `<div class="cw-detail-head"><div class="cw-detail-copy"><h2>${esc(task.title)}</h2><p>${esc(task.goal)}</p>${task.withdrawn ? `<p class="cw-note">${esc(t("board.withdrawn"))}</p>` : ""}<div class="cw-detail-actions"><span class="cw-pill">${esc(t(`root.${task.stage}`))}</span><span class="cw-pill">${esc(task.owner ? `Agent Lock · ${task.owner}` : t("board.waitingLock"))}</span>${button(t("board.source"), `data-source="${esc(task.id)}"`, "inbox")}${task.owner ? button(t("board.api"), `data-agent="${esc(task.owner)}"`, "code") : ""}${task.status === "done" && !task.archived && options.exportTask ? button(t("archive.export"), `data-export-task="${esc(task.id)}"`) : ""}</div></div></div><div class="cw-stats"><span><b>${children.length}</b>${esc(t("board.children"))}</span><span><b>${children.filter(c => c.status === "merged").length}</b>${esc(t("board.mergedCount"))}</span><span class="cw-note">${esc(t("board.detailHint"))}</span></div>` + (task.archived ? `<div class="cw-state"><h2>${esc(t("archive.done"))}</h2><p>${esc(t("archive.retained"))}</p><code>${esc(task.archived.digest)}</code></div>` : children.length ? columns(["queued", "working", "awaiting_test", "passed", "merged"], "child", stage => {
        const list = children.filter(c => (c.status === "rework" ? "queued" : c.status === "testing" ? "awaiting_test" : c.status) === stage);
        return { count: list.length, cards: list.map(childCard).join("") };
      }) : `<div class="cw-state">${icon("list-checks")}<h2>${esc(t(task.owner ? "board.waitingSplit" : "board.waitingLock"))}</h2><p>${esc(t(task.owner ? "board.waitingSplitDetail" : "board.waitingClaimDetail"))}</p></div>`);
    }
    return `<div class="cw-stats"><span><b>${d.tasks.length}</b>${esc(t("board.total"))}</span><span><b>${d.quota.orchestrator.running}</b>${esc(t("board.orchestrators"))}</span><span>Worker <b>${d.quota.worker.running}</b>/ ${d.quota.worker.limit}</span><span>Tester <b>${d.quota.tester.running}</b>/ ${d.quota.tester.limit}</span><span class="cw-note">${esc(t("board.hint"))}</span></div>` + columns(["queued", "running", "merging", "done"], "root", stage => {
      const tasks = d.tasks.filter(task => (task.stage === "planning" ? "running" : task.stage) === stage);
      return { count: tasks.length, cards: tasks.map(task => {
        const children = d.children.filter(c => c.taskId === task.id), merged = children.filter(c => c.status === "merged").length;
        const agents = d.agents.filter(a => a.taskId === task.id && a.state === "running");
        const progress = t("board.merged", { done: merged, total: children.length });
        return `<button type="button" class="cw-card" data-task="${esc(task.id)}"><div class="cw-card-top">${icon("inbox")}<span>${esc(t("board.feedback", { id: task.sourceId }))}</span></div><h3>${esc(task.title)}</h3>${task.withdrawn ? `<span class="cw-pill">${esc(t("board.withdrawn"))}</span>` : ""}<div class="cw-card-meta">${esc(task.owner ? `Agent Lock · ${task.owner}` : t("board.waitingLock"))}</div>${children.length ? `<progress class="cw-progress" max="${children.length}" value="${merged}" aria-label="${esc(progress)}"></progress>` : ""}<div class="cw-card-foot"><span>${esc(children.length ? progress : t("board.notSplit"))}</span><span>${task.stage === "done" ? esc(t("board.delivered")) : `${agents.filter(a => a.role === "worker").length} W · ${agents.filter(a => a.role === "tester").length} T`}</span></div></button>`;
      }).join("") };
    });
  }
  function roles() {
    const data = board(), d = data ? adminSnapshot(data) : undefined;
    return `<p class="cw-note">${esc(t("roles.hint"))}</p>${!d ? `<p class="cw-note">${esc(t("roles.unconnected"))}</p>` : ""}<div class="cw-pools">${ROLES.map(role => {
      const q = d?.quota[role], limit = q?.limit ?? limits[role];
      return `<section class="cw-pool"><h3>${icon(role === "tester" ? "shield-check" : role === "worker" ? "code" : "users")}${esc(t(`role.${role}`))}</h3><strong>${q?.running ?? "—"}</strong><span class="cw-note"> ${esc(t("roles.running", { limit }))}</span><p>${esc(q ? t("roles.available", { count: q.available }) : t("roles.countUnknown"))} · ${esc(t(`roles.${role}`))}</p>${q ? `<progress class="cw-progress" max="${Math.max(1, limit)}" value="${q.running}" aria-label="${esc(t(`role.${role}`))}"></progress>` : ""}${button(t("roles.adjust"), `data-limit="${role}"${!["ready", "unavailable"].includes(connection.state) ? " disabled" : ""}`, "settings")}</section>`;
    }).join("")}</div><div class="cw-stats"><span><b>${d?.agents.length ?? "—"}</b>${esc(t("roles.instances"))}</span><span class="cw-note">${esc(t("roles.retained"))}</span>${button(t("roles.new"), `data-new-agent${!d || !options.createAgent ? " disabled" : ""}`, "plus")}</div>${d?.agents.length ? `<div class="cw-roster">${d.agents.map(a => `<div class="cw-agent-row"><div><b>${esc(a.id)}</b><span class="cw-note">${esc(t(`role.${a.role}`))} · Agent</span></div><div><b>${esc(t(a.state === "running" ? "roles.active" : a.state === "waiting" ? "roles.waiting" : a.taskId ? "roles.finished" : "roles.idle"))}</b><span class="cw-note">${esc(a.childId || a.taskId || t("roles.unassigned"))}</span></div>${button(t("board.api"), `data-agent="${esc(a.id)}"`, "code")}${a.role === "orchestrator" && options.connectAgent ? button(t("roles.connect"), `data-connect="${esc(a.id)}"`) : ""}</div>`).join("")}</div>` : ""}`;
  }
  function api() {
    const data = board(), a = data?.agents.find(a => a.id === identity) ?? data?.agents[0];
    if (!data || !a) return `<div class="cw-state"><h2>${esc(t("api.empty"))}</h2><p>${esc(t("api.emptyHint"))}</p>${button(t("tabs.roles"), 'data-tab="roles"')}</div>`;
    identity = a.id;
    const projection = project(data, a.id);
    return `<div class="cw-stats"><label class="cw-note">${esc(t("api.select"))}<select class="cw-select" data-identity aria-label="${esc(t("api.select"))}">${data.agents.map(agent => `<option value="${esc(agent.id)}"${agent.id === a.id ? " selected" : ""}>${esc(agent.id)} · ${esc(t(`role.${agent.role}`))}</option>`).join("")}</select></label><span class="cw-note">${esc(t("api.hint"))}</span></div><div class="cw-api-grid"><section class="cw-surface"><h3>${icon("code")}${esc(t("api.read", { id: a.id }))}</h3><pre class="cw-code" tabindex="0" aria-label="Agent JSON">${esc(JSON.stringify(projection, null, 2))}</pre></section><section class="cw-surface"><h3>${esc(t("api.operations"))}</h3><p class="cw-note">${esc(t("api.readonly"))}</p><div class="cw-commands">${projection.writable.map(op => `<div class="cw-command"><div><b>${esc(t(`op.${op}`))}</b><code class="cw-note">${op}</code></div></div>`).join("")}</div><details><summary class="cw-note">${esc(t("api.schema"))}</summary><pre class="cw-code" tabindex="0" aria-label="${esc(t("api.schema"))}">${esc(JSON.stringify(writeSchemas(projection.writable), null, 2))}</pre></details></section></div>`;
  }
  function skill() {
    return `<div class="cw-skill"><section class="cw-surface"><span class="cw-pill">${icon("code")}${esc(t("skill.badge"))}</span><h2>${esc(t("skill.title"))}</h2><p>${esc(t("skill.intro"))}</p><label>${esc(t("skill.promptLabel"))}<textarea data-skill-prompt readonly spellcheck="false">${esc(t("skill.prompt"))}</textarea></label><div class="cw-skill-actions">${button(t("skill.selectPrompt"), 'data-select-skill="prompt"', "", true)}${button(t("skill.selectFull"), 'data-select-skill="full"')}</div><div class="cw-skill-status" role="status" aria-live="polite">${skillSelected ? esc(t("skill.selected")) : ""}</div><p>${esc(t("skill.promptHint"))}</p><details data-full><summary>${esc(t("skill.full"))}</summary><label>${esc(t("skill.fullLabel"))}<textarea class="cw-skill-content" data-skill-full readonly spellcheck="false">${esc(SKILL_CONTENT)}</textarea></label><p>${esc(t("skill.language"))}</p></details></section><div class="cw-skill-grid">${["principles", "roles", "interfaces"].map(key => `<section class="cw-surface"><h3>${esc(t(`skill.${key}`))}</h3><p>${esc(t(`skill.${key}Detail`))}</p></section>`).join("")}</div><section class="cw-surface"><h3>${esc(t("skill.status"))}</h3><p>${esc(t("skill.statusDetail"))}</p></section></div>`;
  }
  function markup() {
    const guard = connection.state === "loading" || connection.state === "error" || connection.state === "forbidden";
    return `<nav class="cw-tabs" aria-label="${esc(t("tabs.label"))}">${(["board", "roles", "api", "skill"] as const).map(id => `<button type="button" data-tab="${id}"${tab === id ? ' aria-current="page"' : ""}>${esc(t(`tabs.${id}`))}</button>`).join("")}<span class="cw-note">${esc(t("common.admin"))}</span></nav><div class="cw-content">${tab === "skill" ? skill() : guard ? statePanel(connection.state as "loading" | "error" | "forbidden") : tab === "roles" ? roles() : tab === "api" ? api() : taskBoard()}</div>`;
  }
  function reportNav() {
    const task = board()?.tasks.find(task => task.id === taskId);
    options.onNavigate(tab === "board" && !task ? null : { key: task && tab === "board" ? `task:${task.id}` : tab, label: task && tab === "board" ? task.title : t(`tabs.${tab}`) });
  }
  function render() {
    if (stopped) return;
    skillSelected = false; page.innerHTML = markup(); drawer.setAttribute("aria-label", t("common.dialog")); reportNav();
  }
  function drawerMarkup() {
    if (!dialog) return "";
    if (dialog.kind === "connection") return `<div class="cw-dialog-head"><h2>${esc(t("roles.connect"))}</h2>${closeButton()}</div><p>${esc(t("roles.connectionHint"))}</p><textarea class="cw-skill-content" readonly data-connection>${esc(connectionText)}</textarea>${button(t("skill.selectPrompt"), "data-select-connection")}`;
    if (dialog.kind === "archive" && backup) return `<div class="cw-dialog-head"><h2>${esc(t("archive.export"))}</h2>${closeButton()}</div><p>${esc(t("archive.instructions"))}</p><textarea class="cw-skill-content" readonly data-backup>${esc(backup.text)}</textarea>${button(t("archive.select"), "data-select-backup")}<p><label><input type="checkbox" data-backup-saved> ${esc(t("archive.saved"))}</label></p>${button(t("archive.clean"), "data-clean-task disabled")}<p role="status" data-archive-status></p>`;
    if (dialog.kind === "archive") return "";
    if (dialog.kind === "limit") {
      return `<form data-limit-form><div class="cw-dialog-head"><h2>${esc(t("roles.adjust"))}</h2>${closeButton()}</div><p>${esc(t(board() ? "roles.connectedLimits" : "roles.unconnected"))}</p><label>${esc(t("roles.limitLabel", { role: t(`role.${dialog.role}`) }))}<input name="limit" type="number" step="1" min="0" required value="${limits[dialog.role]}"${saving ? " disabled" : ""}></label><div class="cw-form-status" role="status" aria-live="polite">${formStatus ? esc(t(formStatus)) : ""}</div><footer>${button(t("common.cancel"), `data-close${saving ? " disabled" : ""}`)}<button class="cw-btn primary" type="submit"${saving ? " disabled" : ""}>${esc(t(saving ? "common.saving" : "common.save"))}</button></footer></form>`;
    }
    const id = dialog.id, data = board();
    const record = dialog.kind === "child" ? detail?.id === id ? detail : data?.children.find(c => c.id === id) : data?.tasks.find(task => task.id === id);
    if (!record) return "";
    const fields = dialog.kind === "child" ? (() => {
      const c = record as Child;
      return [[t("evidence.id"), c.id], [t("evidence.status"), t(`child.${c.status}`)], [t("evidence.acceptance"), c.acceptance], ["Worker", c.worker], ["Tester", c.tester], [t("evidence.result"), c.result], [t("evidence.verdict"), c.verdict ? t(`verdict.${c.verdict}`) : null], [t("evidence.evidence"), c.evidence], [t("evidence.merge"), c.mergeRef], [t("evidence.history"), c.history.length ? JSON.stringify(c.history, null, 2) : null]];
    })() : [[t("evidence.source"), "sourceId" in record ? record.sourceId : ""], [t("evidence.goal"), "goal" in record ? record.goal : ""]];
    return `<div class="cw-dialog-head"><h2>${esc(record.title)}</h2>${closeButton()}</div><dl class="cw-evidence">${fields.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value || t("common.none"))}</dd></div>`).join("")}</dl>`;
  }
  function openDrawer(value: NonNullable<typeof dialog>, opener: HTMLElement) {
    returnFocus = opener; dialog = value; formStatus = null; detail = undefined;
    drawer.innerHTML = drawerMarkup(); overlay.hidden = false; page.inert = true;
    drawer.querySelector<HTMLButtonElement>("[data-close]")?.focus();
    if (value.kind === "child" && options.loadChild) void options.loadChild(value.id).then(child => {
      if (stopped || dialog?.kind !== "child" || dialog.id !== child.id) return;
      detail = child; updateLocalizedMarkup(drawer, drawerMarkup());
    }).catch(() => { if (dialog?.kind === "child" && dialog.id === value.id) drawer.querySelector("dd")?.append(` · ${t("evidence.loadFailed")}`); });
  }
  function closeDrawer(restore = true) {
    if (saving && !stopped) return;
    dialog = null; formStatus = null; overlay.hidden = true; page.inert = false;
    if (restore) {
      if (returnFocus?.isConnected) returnFocus.focus();
      else page.querySelector<HTMLElement>("[aria-current=page]")?.focus();
    }
    returnFocus = null; drawer.replaceChildren();
  }
  function navigate(next: Tab, id: string | null = null) {
    closeDrawer(false); tab = next; taskId = id; render();
    page.querySelector<HTMLElement>("[aria-current=page]")?.focus();
  }
  const onClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("button") : null;
    if (!target || target.hasAttribute("disabled")) { if (event.target === overlay) closeDrawer(); return; }
    const ds = target.dataset;
    if ("close" in ds) closeDrawer();
    else if (ds.tab) navigate(ds.tab as Tab);
    else if ("home" in ds) navigate("board");
    else if (ds.task) navigate("board", ds.task);
    else if (ds.exportTask && options.exportTask) {
      target.setAttribute("disabled", "");
      void options.exportTask(ds.exportTask).then(value => { if (!stopped) { backup = { id: ds.exportTask!, ...value }; openDrawer({ kind: "archive" }, target); } })
        .catch(() => { if (!stopped) { connectionText = t("archive.failed"); openDrawer({ kind: "connection" }, target); } }).finally(() => target.removeAttribute("disabled"));
    }
    else if ("selectBackup" in ds) { const field = drawer.querySelector<HTMLTextAreaElement>("[data-backup]"); field?.focus(); field?.select(); }
    else if ("cleanTask" in ds && backup && options.archiveTask && drawer.querySelector<HTMLInputElement>("[data-backup-saved]")?.checked) {
      const copy = backup; saving = true; target.setAttribute("disabled", "");
      void options.archiveTask(copy.id, copy.revision, copy.digest).then(pending => { if (!stopped) { saving = false; if (pending) drawer.querySelector("[data-archive-status]")!.textContent = t("archive.cleanupPending"); else closeDrawer(); } })
        .catch(() => { if (!stopped) { saving = false; drawer.querySelector("[data-archive-status]")!.textContent = t("archive.failed"); } });
    }
    else if (ds.child) openDrawer({ kind: "child", id: ds.child }, target);
    else if (ds.source) openDrawer({ kind: "source", id: ds.source }, target);
    else if (ds.agent) { identity = ds.agent; navigate("api"); }
    else if (ds.limit && ["ready", "unavailable"].includes(connection.state)) openDrawer({ kind: "limit", role: ds.limit as Role }, target);
    else if ("selectConnection" in ds) { const field = drawer.querySelector<HTMLTextAreaElement>("[data-connection]"); field?.focus(); field?.select(); }
    else if ("newAgent" in ds || ds.connect) {
      const request = ds.connect ? options.connectAgent?.(ds.connect) : options.createAgent?.();
      if (!request) return;
      target.setAttribute("disabled", "");
      void request.then(value => {
        if (stopped) return;
        connectionText = `${t("roles.connectionPrompt")} ${JSON.stringify({ endpoint: value.endpoint, token: value.token, method: "invoke", input: { kind: "skill" } })}`;
        openDrawer({ kind: "connection" }, target);
      }).catch(() => { if (!stopped) { connectionText = t("roles.connectionFailed"); openDrawer({ kind: "connection" }, target); } }).finally(() => target.removeAttribute("disabled"));
    }
    else if ("retry" in ds) { target.setAttribute("disabled", ""); void options.retry().catch(() => { if (!stopped) { connection = { state: "error" }; render(); } }); }
    else if (ds.selectSkill) {
      if (ds.selectSkill === "full") page.querySelector<HTMLDetailsElement>("[data-full]")!.open = true;
      const field = page.querySelector<HTMLTextAreaElement>(`[data-skill-${ds.selectSkill}]`)!;
      field.focus(); field.select(); skillSelected = true;
      page.querySelector<HTMLElement>(".cw-skill-status")!.textContent = t("skill.selected");
    }
  };
  const onChange = (event: Event) => {
    if (event.target instanceof HTMLInputElement && event.target.hasAttribute("data-backup-saved")) {
      const button = drawer.querySelector<HTMLButtonElement>("[data-clean-task]"); if (button) button.disabled = saving || !event.target.checked;
    }
    if (event.target instanceof HTMLSelectElement && event.target.hasAttribute("data-identity")) {
      identity = event.target.value; render(); page.querySelector<HTMLElement>("[data-identity]")?.focus();
    }
  };
  const onSubmit = (event: Event) => {
    if (!(event.target instanceof HTMLFormElement) || !event.target.hasAttribute("data-limit-form")) return;
    event.preventDefault();
    if (saving || dialog?.kind !== "limit" || !["ready", "unavailable"].includes(connection.state)) return;
    const role = dialog.role, input = drawer.querySelector<HTMLInputElement>("input")!;
    const value = Number(input.value), status = drawer.querySelector<HTMLElement>(".cw-form-status")!;
    if (!input.value.trim() || !Number.isSafeInteger(value) || value < 0) { formStatus = "roles.invalidLimit"; status.textContent = t(formStatus); return; }
    const next = { ...limits, [role]: value };
    saving = true; formStatus = null; status.textContent = "";
    drawer.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button,input").forEach(el => { el.disabled = true; });
    const submit = drawer.querySelector<HTMLButtonElement>('[type="submit"]')!; submit.textContent = t("common.saving");
    void options.saveDefaults(next).then(() => {
      if (stopped) return;
      limits = next; saving = false; render(); closeDrawer();
    }).catch(() => {
      if (stopped) return;
      saving = false; formStatus = "roles.saveFailed"; status.textContent = t(formStatus);
      drawer.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button,input").forEach(el => { el.disabled = false; });
      submit.textContent = t("common.save");
    });
  };
  const onKey = (event: KeyboardEvent) => {
    if (overlay.hidden) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeDrawer(); }
    if (event.key === "Tab") {
      const nodes = Array.from(drawer.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea,select,[tabindex="0"]'));
      if (!nodes.length) { event.preventDefault(); drawer.focus(); return; }
      const active = root.ownerDocument.activeElement;
      if (event.shiftKey && (active === nodes[0] || active === drawer)) { event.preventDefault(); nodes.at(-1)?.focus(); }
      else if (!event.shiftKey && (active === nodes.at(-1) || active === drawer)) { event.preventDefault(); nodes[0]?.focus(); }
    }
  };
  frame.addEventListener("click", onClick); frame.addEventListener("change", onChange);
  frame.addEventListener("submit", onSubmit); overlay.addEventListener("keydown", onKey);
  render();
  return {
    setConnection(value: Connection, defaults?: Limits) {
      if (stopped) return;
      connection = value; if (value.state === "ready") limits = { ...value.board.limits }; if (defaults) limits = { ...defaults };
      // Revocation must remove open details as well as the board.
      if (value.state !== "ready") { closeDrawer(false); if (saving) { overlay.hidden = true; page.inert = false; dialog = null; } }
      render();
    },
    setLocale(locale: string) {
      if (stopped || !i18n.setLocale(locale)) return;
      updateLocalizedMarkup(page, markup());
      if (dialog) updateLocalizedMarkup(drawer, drawerMarkup());
      drawer.setAttribute("aria-label", t("common.dialog")); reportNav();
    },
    navigateRoot() { if (!stopped) navigate("board"); },
    destroy() {
      if (stopped) return; stopped = true;
      closeDrawer(false);
      frame.removeEventListener("click", onClick); frame.removeEventListener("change", onChange);
      frame.removeEventListener("submit", onSubmit); overlay.removeEventListener("keydown", onKey);
      frame.remove();
    },
  };
}
