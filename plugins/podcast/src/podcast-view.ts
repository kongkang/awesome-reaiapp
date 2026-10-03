/**
 * AI Podcast 大播放器视图（设计稿 #pagePodcast 的 .pod-main + .pod-drawer）。
 *
 * 纯静态演示：数据写死在 data.ts，播放只推进进度条，不真播音频。
 * 渲染进 surface.root（插件 WebView 的根节点），样式走 podcast.css（用宿主注入的 token）。
 *
 * 主页面和抽屉都从 y=44 起；标题与各自操作位于同一条紧凑页头。
 *
 * 语言：可见文案全部走 podcast-i18n（资源 = assets/locales）。静态节点用
 * bindText/bindAttribute 原地更新；动态节点（集标题、元信息、剧集行、播放按钮）
 * 也只建一次，render() 只复用并更新既有节点的文本/属性/类名——切语言与播放
 * tick 都不创建新节点，播放状态、进度与既有 timer 不受影响。
 */
import { icon } from "./icons";
import { POD, POD_SERIES, fmtT, type Episode } from "./data";
import {
  bindAttribute,
  bindText,
  onPodcastLocaleChange,
  releaseLocaleBindings,
  t,
} from "./podcast-i18n";

export interface PodcastView {
  toggleHistory(open?: boolean): void;
  dispose(): void;
}

export function mountPodcastView(root: HTMLElement): PodcastView {
  let disposed = false;
  const state = { ...POD };
  const episodes: Episode[] = [...POD_SERIES];
  let timer: ReturnType<typeof setInterval> | undefined;

  // === 构建 DOM（设计稿 .pod-layout 的结构，去掉侧栏迷你条——那是宿主的事）===
  const frame = el("div", "plugin-main-frame");
  const layout = el("div", "main-body pod-layout");
  const main = el("div", "pod-main");
  const drawer = el("div", "pod-drawer");

  // B9-29/30：自绘页头（h1 + 副题 + Past episodes 按钮）整块撤除——
  // App 身份由 Host 侧栏/面包屑承载，「往期」只走 titlebar（manifest
  // titlebarActions.history → toggle-history intent → toggleDrawer）。
  // Cover
  const cover = el("div", "pod-cover");
  cover.appendChild(icon("podcast", 64, { width: 1.5 }));

  // Info：集标题文本节点与 TBC 标记持久化，render 只改 text.data。
  const info = el("div", "pod-info");
  const titleEl = el("div", "pod-title");
  const episodeTitleText = document.createTextNode("");
  const titleTbc = tbcTag("tbc.podcast-content", "tbc.podcastContent");
  titleEl.append(episodeTitleText, titleTbc);
  const metaEl = el("div", "pod-meta");
  const metaText = document.createTextNode("");
  metaEl.appendChild(metaText);
  info.append(titleEl, metaEl);

  // Progress
  const progress = el("div", "pod-progress");
  const curTime = el("span", "pod-time");
  const bar = el("div", "pod-bar");
  bar.setAttribute("role", "slider");
  bindAttribute(bar, "aria-label", () => t("view.progressAria"));
  bar.setAttribute("aria-valuemin", "0");
  const fill = el("div", "pod-bar-fill");
  bar.appendChild(fill);
  const durTime = el("span", "pod-time pod-time-r");
  progress.append(curTime, bar, durTime);
  progress.appendChild(tbcTag("tbc.podcast-playback", "tbc.podcastProgress"));

  // Controls（静态演示：推进进度条，不真播音频）
  const controls = el("div", "pod-controls");
  const prevBtn = ctrlBtn("skip-back", "view.prevEpisode");
  const backBtn = ctrlBtn("rotate-ccw", "view.back15");
  const playBtn = document.createElement("button");
  playBtn.className = "pod-play";
  playBtn.type = "button";
  const fwdBtn = ctrlBtn("rotate-cw", "view.forward15");
  const nextBtn = ctrlBtn("skip-forward", "view.nextEpisode");
  for (const control of [prevBtn, backBtn, fwdBtn, nextBtn]) {
    control.appendChild(tbcTag("tbc.podcast-playback", "tbc.podcastPlayback"));
  }
  // playBtn 的播放/暂停图标与 TBC 标记各建一次，render 只在图标状态变化时切换引用。
  const playIconNode = icon("play", 20, { filled: true });
  const pauseIconNode = icon("pause-r", 20, { filled: true });
  const playTbc = tbcTag("tbc.podcast-playback", "tbc.podcastPlayback");
  playBtn.append(playIconNode, playTbc);
  controls.append(prevBtn, backBtn, playBtn, fwdBtn, nextBtn);

  main.append(cover, info, progress, controls);

  // B9-36「本期提要」（对稿 #pagePodcast 4293-4302 逐字）：kicker + 标题 + copy +
  // 三张 note-card。稿注：故意让主体超过一屏，验证 main-body 独立滚动时 Host titlebar 不动。
  const notes = el("section", "pod-notes");
  const notesKickerRow = el("div", "pod-notes-kicker-row");
  const notesKicker = el("div", "pod-notes-kicker");
  bindText(notesKicker, () => t("view.notesKicker"));
  notesKickerRow.append(
    notesKicker,
    tbcTag("tbc.podcast-content", "tbc.podcastNotes"),
  );
  const notesTitle = el("div", "pod-notes-title");
  bindText(notesTitle, () => t("view.notesTitle"));
  const notesCopy = el("div", "pod-notes-copy");
  bindText(notesCopy, () => t("view.notesCopy"));
  const notesList = el("div", "pod-notes-list");
  for (const [headKey, copyKey] of [
    ["view.noteProductHead", "view.noteProductBody"],
    ["view.noteTechHead", "view.noteTechBody"],
    ["view.noteTeamHead", "view.noteTeamBody"],
  ] as const) {
    const card = el("div", "pod-note-card");
    const b = el("b");
    bindText(b, () => t(headKey));
    const span = el("span");
    bindText(span, () => t(copyKey));
    card.append(b, span);
    notesList.append(card);
  }
  notes.append(notesKickerRow, notesTitle, notesCopy, notesList);
  main.append(notes);

  // Drawer：标题与 ✕ 同处 y=44 起的紧凑页头
  const drawerHeader = el("div", "pod-drawer-header");
  const drawerTitle = el("span", "pod-drawer-title");
  bindText(drawerTitle, () => t("view.drawerTitle"));
  drawerTitle.appendChild(tbcTag("tbc.podcast-history", "tbc.podcastHistory"));
  drawerHeader.appendChild(drawerTitle);
  const drawerActs = el("div", "pod-drawer-acts");
  const drawerClose = el("button", "pod-drawer-close") as HTMLButtonElement;
  drawerClose.type = "button";
  bindAttribute(drawerClose, "title", () => t("view.closeEpisodes"));
  bindAttribute(drawerClose, "aria-label", () => t("view.closeEpisodes"));
  drawerClose.appendChild(icon("x", 16));
  drawerActs.appendChild(drawerClose);
  const drawerList = el("div", "pod-drawer-list");
  // 剧集行只建一次（点击监听随行绑定）；状态与文案变化由 updateEpisodes 原地写回，
  // 播放 tick 与切语言都不重建行节点，列表内的焦点/选区等瞬态 DOM 状态得以保留。
  const episodeRows = episodes.map((e, i) => {
    const row = el("div", "pod-ep");
    const rowTitle = el("div", "pod-ep-title");
    rowTitle.textContent = e.title;
    const rowMeta = el("div", "pod-ep-meta");
    row.append(rowTitle, rowMeta);
    row.addEventListener("click", () => go(i));
    drawerList.appendChild(row);
    return { row, meta: rowMeta, ep: e };
  });
  drawer.append(drawerHeader, drawerActs, drawerList);

  layout.append(main, drawer);
  frame.appendChild(layout);
  try {
    root.replaceChildren(frame);
  } catch (cause) {
    // 挂载半途失败：此时全部绑定都挂在 frame 子树且尚未进入 root，就地释放，
    // 避免失败后这些孤立节点继续跟随语言切换。
    releaseLocaleBindings(frame);
    throw cause;
  }

  // === 渲染（全原地：不创建新节点，只复用并更新既有节点）===
  function render() {
    const ep = episodes[state.idx]!;
    const pct = Math.min(100, (state.cur / ep.dur) * 100);
    if (episodeTitleText.data !== ep.title) episodeTitleText.data = ep.title;
    const meta = t("view.playerMeta", {
      date: ep.date,
      sources: ep.sources,
      minutes: Math.round(ep.dur / 60),
    });
    if (metaText.data !== meta) metaText.data = meta;
    fill.style.width = `${pct}%`;
    curTime.textContent = fmtT(state.cur);
    durTime.textContent = fmtT(ep.dur);
    bar.setAttribute("aria-valuemax", String(ep.dur));
    bar.setAttribute("aria-valuenow", String(Math.round(state.cur)));
    bar.setAttribute("aria-valuetext", `${fmtT(state.cur)} / ${fmtT(ep.dur)}`);
    const playIcon = state.playing ? pauseIconNode : playIconNode;
    if (playBtn.firstChild !== playIcon) {
      playBtn.replaceChildren(playIcon, playTbc);
    }
    const playTitle = t(state.playing ? "view.pause" : "view.play");
    playBtn.title = playTitle;
    playBtn.setAttribute("aria-label", playTitle);
    updateEpisodes();
  }

  function updateEpisodes() {
    for (const [i, { row, meta: rowMeta, ep }] of episodeRows.entries()) {
      row.classList.toggle("active", i === state.idx);
      const next = t("view.episodeMeta", {
        date: ep.date,
        minutes: Math.round(ep.dur / 60),
        status: i === state.idx && state.playing
          ? t("view.episodePlaying")
          : t("view.episodeSources", { sources: ep.sources }),
      });
      if (rowMeta.textContent !== next) rowMeta.textContent = next;
    }
  }

  // === 事件（静态演示：只推进进度，不真播音频）===
  function pause() {
    state.playing = false;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    render();
  }
  function play() {
    if (state.playing) return;
    state.playing = true;
    timer = setInterval(() => {
      state.cur += 1;
      const total = episodes[state.idx]!.dur;
      if (state.cur >= total) {
        state.cur = total;
        pause();
        return;
      }
      render();
    }, 1000);
    render();
  }
  function seek(seconds: number) {
    // 挡住进度条宽度为 0 时算出的 Infinity/NaN——那会把播放位置写坏。
    if (!Number.isFinite(seconds)) return;
    state.cur = Math.max(0, Math.min(episodes[state.idx]!.dur, seconds));
    render();
  }
  function go(index: number) {
    state.idx = (index + episodes.length) % episodes.length;
    state.cur = 0;
    render();
  }

  playBtn.addEventListener("click", () => (state.playing ? pause() : play()));
  prevBtn.addEventListener("click", () => go(state.idx - 1));
  nextBtn.addEventListener("click", () => go(state.idx + 1));
  backBtn.addEventListener("click", () => seek(state.cur - 15));
  fwdBtn.addEventListener("click", () => seek(state.cur + 15));
  bar.addEventListener("click", (event) => {
    const rect = bar.getBoundingClientRect();
    if (!rect.width) return;
    seek(((event.clientX - rect.left) / rect.width) * episodes[state.idx]!.dur);
  });

  let drawerOpen = false;
  function toggleDrawer(open?: boolean) {
    drawerOpen = open ?? !drawerOpen;
    drawer.classList.toggle("open", drawerOpen);
  }
  drawerClose.addEventListener("click", () => toggleDrawer(false));

  // 语言切换：一次全原地的 render()，不重建任何节点；
  // 不触碰播放状态、进度与既有 timer。
  const stopLocaleRender = onPodcastLocaleChange(() => {
    if (!disposed) render();
  });

  render();

  return {
    toggleHistory: toggleDrawer,
    dispose() {
      if (disposed) return;
      disposed = true;
      stopLocaleRender();
      releaseLocaleBindings(root);
      if (timer) clearInterval(timer);
      timer = undefined;
      root.replaceChildren();
    },
  };
}

function el(tag: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls !== undefined) e.className = cls;
  return e;
}

/** 长效 TBC 标记：title / aria-label 绑定语言，切语言原地更新。 */
function tbcTag(id: string, titleKey: string): HTMLElement {
  const tag = el("span", "tbc-option-tag");
  tag.dataset.tbcId = id;
  tag.textContent = "TBC";
  bindAttribute(tag, "title", () => t(titleKey));
  bindAttribute(tag, "aria-label", () => t("view.tbcAria", { title: t(titleKey) }));
  return tag;
}

function ctrlBtn(name: Parameters<typeof icon>[0], titleKey: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "pod-btn";
  b.type = "button";
  bindAttribute(b, "title", () => t(titleKey));
  bindAttribute(b, "aria-label", () => t(titleKey));
  b.appendChild(icon(name, 18));
  return b;
}
