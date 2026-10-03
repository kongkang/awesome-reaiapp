import type { AppContext } from "@reai/app-sdk/v1";
import qrcode from "qrcode-generator";
import {
  CATEGORIES,
  CATEGORY_LABELS,
  HOME_CACHE_KEY,
  HOME_CACHE_TTL,
  MAX_DETAIL_CHARS,
  MAX_NICKNAME,
  MAX_WISH_CHARS,
  MIN_CHARS,
  SESSION_USER_KEY,
  SITE_URL,
  STAGE_LABELS,
  STORE_ID,
  STORE_KEY,
  TONES,
  WAINAO_API_ORIGIN,
  WAINAO_ASSERTION_PATH,
  WALL_AUDIENCE,
  WALL_AUTH_PATH,
  WALL_URL,
  type Category,
  type HomeCache,
  type HomeResponse,
  type RemoteProject,
  type RemoteWish,
  type SessionUser,
  type Tone,
  type Wish,
  mapRemoteWish,
} from "./types";

/**
 * AI许愿墙主视图。
 *
 * 左栏表单（愿望 + 分类 + 落款 + 贴上墙），右栏三 tab：
 *  · 许愿墙：远程公开卡片 + 本地草稿瀑布流，点卡片弹窗看详情 / 点共鸣
 *  · 成真中：愿望正在成真的项目（照原项目深橄榄卡片风格）
 *  · 扫码：QR 入口（只编码墙站主页，无凭证）
 *
 * 鉴权（v0.4.0 接通 Host oauth_app 通道，#293 断言链路）：插件自己的
 * 外脑 OAuth App（manifest oauthAppId）→ Host 代签取得令牌（插件取不回，
 * Bearer 只注入外脑域）→ 向外脑断言端点换 aud=墙站 的短时断言
 * → POST 握手端点 → 墙站 Set-Cookie 由 Host 的 managed_cookie jar 自动
 * 保存/携带。外脑断言端点未上线/未连接时 getWallAssertion 返回 null，
 * 写请求优雅降级为本地草稿；会话失效（401）→ 重建一次 → 重试。
 */
export function mountWishingWallView(
  root: HTMLElement,
  ctx: AppContext,
): { dispose: () => void } {
  let disposed = false;
  let category: Category = "life";
  const wishes: Wish[] = [];
  const remoteWishes: Wish[] = [];
  const projects: RemoteProject[] = [];
  let localWishesLoaded = false;

  // ---- DOM 骨架 ----
  const frame = el("div", "plugin-main-frame");
  const app = el("div", "main-body ww-app");
  frame.appendChild(app);

  // ===== 左栏：表单 =====
  const formPane = el("div", "ww-form-pane");
  const formTop = el("div", "ww-form-top");
  const title = el("div", "ww-form-title");
  title.append(el("span", "ww-form-aka", "疯狂点子王"));
  formTop.append(
    title,
    el("div", "ww-form-sub", "把你的期许，说给未来听"),
  );

  const formBody = el("div", "ww-form-body");

  // 愿望 textarea
  const fieldWish = el("div");
  fieldWish.append(el("div", "ww-field-label", "你的愿望"));
  const textarea = document.createElement("textarea");
  textarea.className = "ww-textarea";
  textarea.maxLength = MAX_WISH_CHARS;
  textarea.placeholder = "比如：想要一个能自动整理桌面的工具";
  fieldWish.append(textarea);

  // 分类
  const fieldCat = el("div");
  fieldCat.append(el("div", "ww-field-label", "分类"));
  const catsEl = el("div", "ww-cats");
  for (const cat of CATEGORIES) {
    const btn = el("button", cat === category ? "ww-cat is-active" : "ww-cat");
    btn.type = "button";
    btn.dataset.cat = cat;
    btn.textContent = CATEGORY_LABELS[cat];
    catsEl.append(btn);
  }
  fieldCat.append(catsEl);

  // 落款（选填）
  const fieldNick = el("div");
  const nickLabel = el("div", "ww-field-label");
  nickLabel.append(
    document.createTextNode("落款 "),
    Object.assign(el("span", ""), {
      textContent: "（选填，显示在卡片上）",
      style: "font-weight:400;text-transform:none;color:var(--text-tertiary)",
    }),
  );
  fieldNick.append(nickLabel);
  const nickInput = document.createElement("input");
  nickInput.className = "ww-input";
  nickInput.type = "text";
  nickInput.maxLength = MAX_NICKNAME;
  nickInput.placeholder = "你的昵称";
  fieldNick.append(nickInput);

  // 详情（选填）
  const fieldDetail = el("div");
  const detailLabel = el("div", "ww-field-label");
  detailLabel.append(
    document.createTextNode("补充说明 "),
    Object.assign(el("span", ""), {
      textContent: "想多说几句？展开说说！",
      style: "font-weight:400;text-transform:none;color:var(--text-tertiary)",
    }),
  );
  fieldDetail.append(detailLabel);
  const detailInput = document.createElement("textarea");
  detailInput.className = "ww-textarea";
  detailInput.style.minHeight = "60px";
  detailInput.maxLength = MAX_DETAIL_CHARS;
  detailInput.placeholder = "更详细的背景、场景或期待…";
  const detailCounter = el("div", "ww-detail-counter", "0/" + MAX_DETAIL_CHARS);
  fieldDetail.append(detailInput, detailCounter);

  formBody.append(fieldWish, fieldCat, fieldNick, fieldDetail);

  // 底部：字数 + 保存本地草稿
  const formFoot = el("div", "ww-form-foot");
  const counter = el("span", "ww-counter", "0/" + MAX_WISH_CHARS);
  const postBtn = el("button", "ww-post-btn", "✦ 贴上墙");
  postBtn.type = "button";
  postBtn.disabled = true;
  formFoot.append(counter, postBtn);
  const saveFeedback = el("div", "ww-save-feedback");
  saveFeedback.setAttribute("role", "status");
  saveFeedback.setAttribute("aria-live", "polite");
  saveFeedback.textContent = "正在读取本机草稿…";

  formPane.append(formTop, formBody, saveFeedback, formFoot);

  // ===== 右栏：墙 / 扫码 =====
  const wallPane = el("div", "ww-wall-pane");

  // tab 栏
  const tabs = el("div", "ww-wall-tabs");
  const tabWall = el("button", "ww-tab is-active", "许愿墙");
  tabWall.type = "button";
  tabWall.dataset.tab = "wall";
  const tabProjects = el("button", "ww-tab", "成真中");
  tabProjects.type = "button";
  tabProjects.dataset.tab = "projects";
  const tabQR = el("button", "ww-tab", "扫码");
  tabQR.type = "button";
  tabQR.dataset.tab = "qr";
  const refreshBtn = el("button", "ww-refresh-btn", "↻");
  refreshBtn.type = "button";
  refreshBtn.title = "换一批随机愿望";
  // 会话用户区：断言握手成功显示墙站昵称；链路未就绪显示待开放态。
  // 会话本体在 Host 的 managed_cookie jar（进程内存），这里只做展示缓存。
  const userChip = el("div", "ww-user is-out");
  tabs.append(tabWall, tabProjects, tabQR, refreshBtn, userChip);

  // 墙视图
  const wallScroll = el("div", "ww-wall-scroll");
  const wallIntro = el("div", "ww-section-intro");
  const wallHead = el("div");
  wallHead.append(
    Object.assign(el("span", "ww-section-index"), { textContent: "01" }),
    el("h2", "", "许愿墙"),
  );
  wallIntro.append(
    wallHead,
    el("p", "", "把你的期许，说给未来听"),
  );
  const wallGrid = el("div", "ww-wall-grid");
  const wallEmpty = el("div", "ww-wall-empty");
  wallEmpty.style.display = "none";
  wallScroll.append(wallIntro, wallGrid, wallEmpty);

  // 成真中视图（愿望正在成真）
  const projectsScroll = el("div", "ww-project-scroll");
  projectsScroll.style.display = "none";
  const projectsIntro = el("div", "ww-section-intro");
  const introHead = el("div");
  introHead.append(
    Object.assign(el("span", "ww-section-index"), { textContent: "02" }),
    el("h2", "", "愿望正在成真"),
  );
  projectsIntro.append(
    introHead,
    el("p", "", "从一句愿望，到一个真正有人使用的项目"),
  );
  const projectsGrid = el("div", "ww-project-grid");
  const projectsEmpty = el("div", "ww-project-empty");
  projectsEmpty.style.display = "none";
  projectsScroll.append(projectsIntro, projectsGrid, projectsEmpty);

  // 扫码视图
  const qrView = el("div", "ww-qr-view");
  qrView.style.display = "none";
  const qrCard = el("div", "ww-qr-card");
  const qrFrame = el("div", "ww-qr-frame");
  const qrUrlText = el("div", "ww-qr-url", "AI许愿墙 · 疯狂点子王");
  qrCard.append(qrFrame, qrUrlText);
  const qrState = el("div", "ww-qr-state", "扫码打开许愿墙");
  const qrHint = el("div", "ww-qr-hint", "用手机扫码，在许愿墙发布你的愿望");
  qrView.append(qrCard, qrState, qrHint);

  wallPane.append(tabs, wallScroll, projectsScroll, qrView);
  app.append(formPane, wallPane);
  root.append(frame);

  // 弹窗挂载点
  const modalMount = el("div");
  app.append(modalMount);

  // ---- 事件：textarea ----
  textarea.addEventListener("input", () => {
    const len = textarea.value.length;
    counter.textContent = len + "/" + MAX_WISH_CHARS;
    counter.classList.toggle("is-over", len > MAX_WISH_CHARS);
    postBtn.disabled = !localWishesLoaded || textarea.value.trim().length < MIN_CHARS;
    if (localWishesLoaded) {
      saveFeedback.textContent = "";
      saveFeedback.classList.remove("is-error");
    }
  });

  // ---- 事件：详情输入 ----
  detailInput.addEventListener("input", () => {
    const len = detailInput.value.length;
    detailCounter.textContent = len + "/" + MAX_DETAIL_CHARS;
    detailCounter.classList.toggle("is-over", len > MAX_DETAIL_CHARS);
  });

  // ---- 事件：分类 ----
  catsEl.addEventListener("click", (e: Event) => {
    const btn = (e.target as HTMLElement).closest(".ww-cat") as HTMLButtonElement | null;
    if (!btn) return;
    catsEl.querySelectorAll(".ww-cat").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    category = btn.dataset.cat as Category;
  });

  // ---- 事件：贴上墙（提交到墙站；非业务失败回退本地草稿）----
  let postBusy = false;
  postBtn.addEventListener("click", async () => {
    if (disposed || postBusy || !localWishesLoaded) return;
    const text = textarea.value.trim();
    if (!text || text.length < MIN_CHARS) return;
    postBusy = true;
    postBtn.disabled = true;
    saveFeedback.textContent = "正在发布到墙站…";
    saveFeedback.classList.remove("is-error");
    const nickname = nickInput.value.trim();
    const detail = detailInput.value.trim();

    const saveLocal = async (reason: string): Promise<void> => {
      const wish: Wish = {
        id: "w_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
        text,
        category,
        nickname: nickname || "匿名（本地）",
        tone: TONES[Math.floor(Math.random() * TONES.length)] as Tone,
        rotate: (Math.random() * 5 - 2.5).toFixed(1),
        createdAt: Date.now(),
        detail: detail || undefined,
      };
      try {
        await saveWishes([wish, ...wishes]);
        wishes.unshift(wish);
        renderWall();
        textarea.value = "";
        detailInput.value = "";
        counter.textContent = "0/" + MAX_WISH_CHARS;
        detailCounter.textContent = "0/" + MAX_DETAIL_CHARS;
        saveFeedback.textContent = `发布未成功（${reason}），已存为本地草稿`;
      } catch {
        saveFeedback.textContent = `发布未成功（${reason}），本地保存也失败了，内容仍在输入框`;
        saveFeedback.classList.add("is-error");
      }
    };

    try {
      const body: Record<string, string> = { text, category };
      // 墙站落款契约 2–24 字：不足 2 字不发送（墙站回退账号昵称），本地草稿不受影响
      if (nickname && nickname.length >= 2) body.nickname = nickname;
      if (detail && detail.length >= MIN_CHARS) body.detail = detail;
      const res = await wallWrite("/api/wishes", JSON.stringify(body));
      if (res.ok) {
        // 成功 → 用墙站返回的愿望数据插到墙上最前面（拿不到就用本地信息）
        const data = await res.json().catch(() => null) as {
          wish?: { id: string; tone: string; rotate: string; people?: number; author?: { zh?: string } };
        } | null;
        const wish: Wish = {
          id: "remote_" + (data?.wish?.id || Date.now()),
          text,
          category,
          nickname: data?.wish?.author?.zh || nickname || "我",
          tone: (TONES.includes(data?.wish?.tone as Tone) ? data?.wish?.tone : "lime") as Tone,
          rotate: String(data?.wish?.rotate ?? 0),
          createdAt: Date.now(),
          supportCount: data?.wish?.people || 0,
          supported: false,
          detail: detail || undefined,
        };
        remoteWishes.unshift(wish);
        renderWall();
        textarea.value = "";
        detailInput.value = "";
        counter.textContent = "0/" + MAX_WISH_CHARS;
        detailCounter.textContent = "0/" + MAX_DETAIL_CHARS;
        saveFeedback.textContent = "已发布到墙站 ✦";
      } else {
        // 业务约束按错误码区分（墙站契约 v0.3.3）
        const errData = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
        const code = errData?.error?.code || "";
        if (res.status === 503) {
          // wallWrite：断言身份链路未就绪（#293），降级本地草稿
          await saveLocal("桌面端发布即将开放");
        } else if (res.status === 429 && code === "daily_wish_limit") {
          saveFeedback.textContent = "今天已经许过愿望啦，明天再来 ✦";
        } else if (res.status === 429) {
          saveFeedback.textContent = "操作太频繁了，请一分钟后再试";
        } else if (res.status === 403 && code === "account_blocked") {
          saveFeedback.textContent = "该身份已被墙站封禁，内容仍在输入框";
          saveFeedback.classList.add("is-error");
        } else {
          await saveLocal(errData?.error?.message || `墙站返回 ${res.status}`);
        }
      }
    } catch (e) {
      const err = e as { message?: string };
      await saveLocal(err?.message || "网络错误");
    } finally {
      postBusy = false;
      postBtn.disabled = textarea.value.trim().length < MIN_CHARS;
      if (!wallError) textarea.focus();
    }
  });

  // ---- 事件：tab 切换 ----
  tabs.addEventListener("click", (e: Event) => {
    const tab = (e.target as HTMLElement).closest(".ww-tab") as HTMLButtonElement | null;
    if (!tab) return;
    const which = tab.dataset.tab;
    tabWall.classList.toggle("is-active", which === "wall");
    tabProjects.classList.toggle("is-active", which === "projects");
    tabQR.classList.toggle("is-active", which === "qr");
    wallScroll.style.display = which === "wall" ? "" : "none";
    projectsScroll.style.display = which === "projects" ? "" : "none";
    qrView.style.display = which === "qr" ? "flex" : "none";
  });

  // ---- 事件：点卡片 → 弹窗 ----
  wallGrid.addEventListener("click", (e: Event) => {
    const card = (e.target as HTMLElement).closest(".ww-card") as HTMLElement | null;
    if (!card) return;
    const w = [...remoteWishes, ...wishes].find((x) => x.id === card.dataset.id);
    if (w) showModal(w);
  });

  // ---- 渲染墙（loading / error / empty / 数据 四态）----
  function renderWall(): void {
    const all = [...remoteWishes, ...wishes];
    wallGrid.innerHTML = "";
    wallEmpty.innerHTML = "";
    // 首次加载中（无数据）：转圈占位
    if (loading && all.length === 0 && !wallError) {
      wallEmpty.style.display = "flex";
      wallEmpty.append(el("div", "ww-spinner"), el("div", "", "正在拉取愿望…"));
      return;
    }
    // 拉取失败且无数据：错误
    if (wallError && all.length === 0) {
      wallEmpty.style.display = "flex";
      wallEmpty.append(
        Object.assign(el("div"), { style: "font-size:28px", textContent: "⚠" }),
        el("div", "", "拉取愿望失败"),
        Object.assign(el("div"), { style: "font-size:11px;opacity:.6;word-break:break-all", textContent: wallError }),
      );
      return;
    }
    // 无数据（请求完成、非错误）：空状态
    if (all.length === 0) {
      wallEmpty.style.display = "flex";
      wallEmpty.append(
        Object.assign(el("div"), { style: "font-size:32px", textContent: "✦" }),
        el("div", "", "还没有公开愿望\n你可以先保存一条本地草稿"),
      );
      return;
    }
    wallEmpty.style.display = "none";
    all.forEach((w, i) => {
      const card = el("div", "ww-card tone-" + w.tone);
      card.dataset.id = w.id;
      card.style.setProperty("--rotate", w.rotate + "deg");
      card.style.setProperty("--delay", Math.min(i * 60, 600) + "ms");
      // meta: 分类 + 时间
      const isLocal = !w.id.startsWith("remote_");
      const categoryMeta = el("span", "", CATEGORY_LABELS[w.category] || w.category);
      if (isLocal) categoryMeta.append(el("span", "ww-card-local", "本地草稿"));
      const meta = el("div", "ww-card-meta");
      meta.append(
        categoryMeta,
        el("time", "", formatTime(w.createdAt)),
      );
      card.append(
        meta,
        el("div", "ww-card-text", w.text),
        (() => {
          const foot = el("div", "ww-card-foot");
          foot.append(
            el("span", "ww-card-author", w.nickname),
            el("span", "ww-card-cat", isLocal ? "仅保存在本机" : "✦ " + (w.supportCount || 0)),
          );
          return foot;
        })(),
      );
      wallGrid.append(card);
    });
  }

  // ---- 渲染项目（loading / empty / 数据）----
  function renderProjects(): void {
    projectsGrid.innerHTML = "";
    projectsEmpty.innerHTML = "";
    // 首次加载中（无数据）：转圈占位
    if (loading && projects.length === 0 && !wallError) {
      projectsEmpty.style.display = "flex";
      projectsEmpty.append(el("div", "ww-spinner"), el("div", "", "正在拉取项目…"));
      return;
    }
    // 无数据：空状态（错误跟随墙 tab 显示，这里不重复）
    if (projects.length === 0) {
      projectsEmpty.style.display = "flex";
      projectsEmpty.append(
        Object.assign(el("div"), { style: "font-size:32px", textContent: "✦" }),
        el("div", "", "还没有愿望成真\n许下你的愿望，也许下一个就是你"),
      );
      return;
    }
    projectsEmpty.style.display = "none";
    projects.forEach((p) => {
      const card = el("article", "ww-project-card");
      card.style.setProperty("--project-color", p.color || "#5c5ce0");
      // 顶部：阶段徽章 + 项目编号
      const top = el("div", "ww-project-top");
      const badge = el("span", "ww-stage-badge " + (p.stage || ""));
      badge.append(
        el("i"),
        document.createTextNode(STAGE_LABELS[p.stage] || p.stage || ""),
      );
      top.append(badge, el("span", "ww-project-id", p.id));
      // ✦ 标记
      const symbol = el("div", "ww-project-symbol");
      symbol.append(Object.assign(el("span"), { textContent: "✦" }));
      // 标题
      const title = el("h3", "ww-project-title", p.title?.zh || p.title?.en || "");
      // 源愿望引用
      const origin = el("p", "ww-project-origin");
      origin.append(
        el("small", "", "源自愿望"),
        document.createTextNode('"' + (p.wish?.zh || p.wish?.en || "") + '"'),
      );
      // 底部：maker + 共创人数
      const footer = el("div", "ww-project-footer");
      const footInfo = el("div");
      footInfo.append(
        el("strong", "", p.maker?.zh || p.maker?.en || ""),
        el("small", "", (p.people || 0) + " 人参与共创"),
      );
      footer.append(footInfo);
      card.append(top, symbol, title, origin, footer);
      projectsGrid.append(card);
    });
  }

  // ---- 详情面板（右滑入场 + 共鸣）----
  function showModal(w: Wish): void {
    const overlay = el("div", "ww-modal-overlay");
    const panel = el("div", "ww-modal tone-" + w.tone);
    const closeBtn = el("button", "ww-modal-close", "✕");
    closeBtn.type = "button";
    const isRemote = w.id.startsWith("remote_");
    panel.append(
      closeBtn,
      el(
        "span",
        "ww-modal-cat",
        `${CATEGORY_LABELS[w.category] || w.category}${isRemote ? "" : " · 本地草稿"}`,
      ),
      el("div", "ww-modal-text", w.text),
    );
    if (w.detail && w.detail !== w.text) {
      panel.append(el("div", "ww-modal-detail", w.detail));
    }

    // 底部：作者 + 共鸣按钮
    const foot = el("div", "ww-modal-foot");
    foot.append(el("span", "ww-modal-author", "—— " + w.nickname));

    // 共鸣（v0.3.0 恢复）：wallWrite 自带会话管理（握手 + 401 重试）
    if (isRemote) {
      const wishId = w.id.replace("remote_", "");
      const supportBtn = el("button", "ww-support-btn");
      supportBtn.type = "button";
      const supportCountEl = el("span", "", String(w.supportCount || 0));
      const updateSupportUI = (supported: boolean, count: number) => {
        supportBtn.classList.toggle("is-active", supported);
        supportCountEl.textContent = String(count);
      };
      updateSupportUI(w.supported || false, w.supportCount || 0);
      supportBtn.append(el("span", "", "✦"), document.createTextNode(" "), supportCountEl);
      supportBtn.addEventListener("click", async () => {
        supportBtn.disabled = true;
        // 乐观更新
        const wasSupported = supportBtn.classList.contains("is-active");
        updateSupportUI(!wasSupported, (w.supportCount || 0) + (wasSupported ? -1 : 1));
        try {
          const res = await wallWrite(`/api/wishes/${wishId}/supports`);
          if (res.ok) {
            const data = await res.json().catch(() => null) as { supported?: boolean; count?: number } | null;
            w.supported = data?.supported ?? !wasSupported;
            w.supportCount = data?.count ?? (w.supportCount || 0) + (wasSupported ? -1 : 1);
            updateSupportUI(w.supported, w.supportCount);
            renderWall();
          } else {
            // 回滚（429 限流 / 其他失败）
            updateSupportUI(wasSupported, w.supportCount || 0);
          }
        } catch {
          updateSupportUI(wasSupported, w.supportCount || 0);
        } finally {
          supportBtn.disabled = false;
        }
      });
      foot.append(supportBtn);
    }
    panel.append(foot);

    overlay.append(panel);
    overlay.addEventListener("click", (e: Event) => {
      if (e.target === overlay || (e.target as HTMLElement).closest(".ww-modal-close")) {
        overlay.remove();
      }
    });
    modalMount.append(overlay);
  }

  // ---- QR（纯入口，不随愿望输入变化）----
  async function updateQR(): Promise<void> {
    if (disposed) return;
    // QR 直接编墙站主页 URL——不携带 token 等凭证，避免泄露。
    // 用户扫码到主页后，自己在浏览器登录/提交/共鸣；客户端不参与登录态。
    const text = SITE_URL;
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    qrFrame.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0 });
    qrUrlText.textContent = "AI许愿墙 · 疯狂点子王";
  }

  // ---- KV 持久化 ----
  const store = ctx.storage.private(STORE_ID);
  // SDK 的 KeyValueStore.get 默认 T=unknown，在 strict 下赋给 string 会报 `{} not assignable to string`。
  // KV 实际只存 string（其余通过 JSON.stringify 后再存），统一在这里断言，避免散落的强转。
  const kvGetString = (key: string): Promise<string | undefined> =>
    store.get(key) as Promise<string | undefined>;

  async function saveWishes(nextWishes: Wish[]): Promise<void> {
    await store.set(STORE_KEY, JSON.stringify(nextWishes));
  }

  // ---- 墙站会话（managed_cookie；凭证链路 = 外壳代签 + 外脑受众断言，#293）----
  // 进程内标志：本进程已成功握手过。Host 的 cookie jar 是进程内存，
  // App 重启即失效——重启后首次写请求会重新握手（一次 POST，无感）。
  let sessionReady = false;

  /**
   * 墙站握手凭证：经 Host oauth_app 通道向 外脑 受众断言端点请求
   * aud=墙站 的短时 JWT（#293 第 7 条）。
   *
   * 通道（Host 已上线，PR #377）：插件在 manifest 声明自己的外脑
   * OAuth App（oauthAppId）+ oauth_app 端点；用户在 Host 设置页连接、
   * 授权弹窗确认后，外壳代签取得插件 App 令牌（插件取不回），请求
   * WAINAO_API_ORIGIN 时由 Network Broker 注入 Bearer。断言不是
   * bearer 凭证：受众绑定、短时效，出了握手这一步没有别处可用。
   *
   * 降级（返回 null）：未连接插件 OAuth App（Host 稳定错误码
   * PLUGIN_OAUTH_REAUTH_REQUIRED）/ 外脑断言端点未上线（404、503）/
   * 响应形状不符——写请求一律降级为本地草稿，与 0.3.x 行为一致。
   * ⚠ 不要在这里生成 UUID / 自签 token 等自造凭证——墙站按外脑用户
   * upsert，自造身份会与 ReAI 账号体系永久分叉。
   */
  async function getWallAssertion(): Promise<string | null> {
    try {
      const res = await ctx.http.fetch(`${WAINAO_API_ORIGIN}${WAINAO_ASSERTION_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // 请求/响应形状为占位（外脑端点未定稿）：定稿后只改本函数。
        body: JSON.stringify({ aud: WALL_AUDIENCE }),
      });
      if (!res.ok) return null;
      const data = await res.json().catch(() => null) as { assertion?: string } | null;
      return typeof data?.assertion === "string" && data.assertion.length > 0
        ? data.assertion
        : null;
    } catch {
      return null; // Host 拒绝（未连接等）或网络失败 → 降级本地草稿
    }
  }

  /**
   * 与墙站建立 cookie 会话：用受众断言 POST 握手端点（WALL_AUTH_PATH）。
   * 墙站验断言后按其中的用户 upsert，Set-Cookie 由 Host 的 managed_cookie
   * jar 自动保存——插件不解析、不持有任何凭证。握手成功缓存会话用户
   * （仅展示用）。墙站建议「拿到断言后再调」：本函数只在需要写
   * （提交/共鸣）且会话未就绪时调用。
   */
  async function ensureSession(): Promise<boolean> {
    if (disposed) return false;
    const assertion = await getWallAssertion();
    if (!assertion) {
      sessionReady = false;
      return false; // 平台身份链路未就绪 → 写请求降级为本地草稿
    }
    try {
      const res = await ctx.http.fetch(`${WALL_URL}${WALL_AUTH_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assertion }),
      });
      sessionReady = res.ok;
      if (res.ok) {
        const data = await res.json().catch(() => null) as {
          authenticated?: boolean;
          user?: { displayName?: string };
        } | null;
        if (data?.authenticated) {
          const user: SessionUser = {
            displayName: data.user?.displayName || "墙站用户",
            linkedAt: Date.now(),
          };
          renderSessionUser(user);
          store.set(SESSION_USER_KEY, JSON.stringify(user)).catch(() => {
            /* 展示缓存写失败可忽略 */
          });
        }
      }
      return res.ok;
    } catch {
      sessionReady = false;
      return false;
    }
  }

  /**
   * 写请求包装：会话未就绪先握手；401 重建会话后重试一次（防循环）。
   * cookie 由 Host jar 自动携带——这里不碰任何 header。
   */
  async function wallWrite(path: string, body?: string): Promise<Response> {
    if (!sessionReady && !(await ensureSession())) {
      // 握手失败（断言链路未就绪/网络断/墙站不可用）：不发主请求，
      // 直接给个 503 语义的失败
      return new Response(null, { status: 503 });
    }
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body ? { body } : {}),
    };
    let res = await ctx.http.fetch(`${WALL_URL}${path}`, init);
    if (res.status === 401) {
      // 会话失效（jar 过期/被清）→ 重建一次 → 重试一次
      sessionReady = false;
      if (await ensureSession()) {
        res = await ctx.http.fetch(`${WALL_URL}${path}`, init);
      }
    }
    return res;
  }

  // ---- 会话用户展示（tab 栏右侧）----
  function renderSessionUser(user: SessionUser | null): void {
    userChip.classList.toggle("is-out", !user);
    userChip.replaceChildren();
    const name = el("span", "ww-user-name");
    name.textContent = user ? user.displayName : "桌面登录待开放";
    userChip.append(name);
  }

  // 启动时读上次会话用户（仅展示缓存；会话本体在 Host jar，重启即失效，
  // 下次写请求会重新握手刷新）。读不到 → 待开放态。
  async function loadSessionUser(): Promise<void> {
    try {
      const raw = await kvGetString(SESSION_USER_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as SessionUser;
      if (parsed && typeof parsed.displayName === "string" && parsed.displayName) {
        renderSessionUser(parsed);
      }
    } catch {
      // 损坏数据忽略，保持待开放态
    }
  }

  async function loadWishes(): Promise<void> {
    try {
      const raw = await kvGetString(STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Wish[];
        if (Array.isArray(parsed)) {
          wishes.push(...parsed.filter((w) => w && w.id && w.text));
        }
      }
    } catch {
      // 损坏数据忽略，从空墙开始
    }
    localWishesLoaded = true;
    postBtn.disabled = textarea.value.trim().length < MIN_CHARS;
    saveFeedback.textContent = "";
    renderWall();
  }

  // 0.2.0 曾把长期墙站 token 落到 KV；0.2.1 不再使用身份或写接口，启动即清理。
  async function clearLegacyWallToken(): Promise<void> {
    try {
      await store.delete("wall_token");
    } catch {
      // 清理失败不影响只读浏览；新版本不会再读取或发送该值。
    }
  }

  // ---- 拉取远程随机愿望 ----
  let wallError: string | null = null;
  let loading = false;

  // ---- home 缓存（减少重复请求 + 离线兜底）----
  async function readHomeCache(): Promise<HomeCache | null> {
    try {
      const raw = await kvGetString(HOME_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as HomeCache;
      if (!parsed || typeof parsed.cachedAt !== "number") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async function writeHomeCache(wishes: RemoteWish[], projs: RemoteProject[]): Promise<void> {
    try {
      const entry: HomeCache = { cachedAt: Date.now(), wishes, projects: projs };
      await store.set(HOME_CACHE_KEY, JSON.stringify(entry));
    } catch {
      /* KV 写失败静默——不影响主流程 */
    }
  }

  // ---- 启动：缓存未过期则秒开、不请求；过期或无缓存才拉取 ----
  async function bootHome(): Promise<void> {
    if (disposed) return;
    const cached = await readHomeCache();
    if (cached && Date.now() - cached.cachedAt <= HOME_CACHE_TTL) {
      // 缓存命中：直接渲染，不发请求
      remoteWishes.push(...cached.wishes.map(mapRemoteWish));
      projects.push(...cached.projects);
      renderWall();
      renderProjects();
      return;
    }
    // 过期或无缓存：先显示 loading 占位，再拉取（失败会自动降级到旧缓存）
    loading = true;
    renderWall();
    renderProjects();
    void loadRemoteWishes();
  }

  async function loadRemoteWishes(): Promise<void> {
    if (disposed) return;
    refreshBtn.disabled = true;
    loading = true;
    wallError = null;
    // 首次（无数据）立即显示 loading 占位；有数据则保留不清屏
    if (remoteWishes.length === 0 && projects.length === 0) {
      renderWall();
      renderProjects();
    }
    try {
      // wishLimit 上限 12（墙站 boundedInteger 钳制），按真实值请求
      const res = await ctx.http.fetch(`${WALL_URL}/api/home?wishLimit=12&projectLimit=6`);
      if (disposed) return;
      if (!res.ok) throw new Error(`墙站返回 ${res.status}`);
      const data = (await res.json()) as HomeResponse;
      if (disposed) return;
      if (data.wishes) {
        remoteWishes.length = 0;
        remoteWishes.push(...data.wishes.map(mapRemoteWish));
      }
      if (data.projects) {
        projects.length = 0;
        projects.push(...data.projects);
      }
      void writeHomeCache(data.wishes || [], data.projects || []);
    } catch (e) {
      if (disposed) return;
      // 失败降级：已有数据则保留静默；否则用缓存兜底；都没有才报错
      if (remoteWishes.length === 0 && projects.length === 0) {
        const cached = await readHomeCache();
        if (cached && (cached.wishes.length || cached.projects.length)) {
          remoteWishes.push(...cached.wishes.map(mapRemoteWish));
          projects.push(...cached.projects);
        } else {
          const err = e as { message?: string; code?: string };
          wallError = err?.message || err?.code || (typeof e === "string" ? e : "拉取失败，请稍后重试");
        }
      }
    } finally {
      if (!disposed) {
        loading = false;
        renderWall();
        renderProjects();
        refreshBtn.disabled = false;
      }
    }
  }

  refreshBtn.addEventListener("click", () => void loadRemoteWishes());

  // ---- 启动 ----
  void updateQR();
  void loadWishes();
  void loadSessionUser();
  void clearLegacyWallToken();
  // home 数据：缓存未过期则秒开 0 请求，过期或无缓存才拉取
  void bootHome();

  return {
    dispose(): void {
      disposed = true;
      root.innerHTML = "";
    },
  };
}

// ---- 工具 ----
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return (
    d.getMonth() + 1 + "/" + d.getDate() + " " +
    String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0")
  );
}
