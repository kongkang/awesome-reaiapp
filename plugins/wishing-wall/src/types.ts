/**
 * 许愿墙插件的类型定义。
 *
 * 桌面端写下的愿望只存 storage.kv；墙站网络能力仅用于只读浏览公开内容。
 * 扫码只打开墙站主页，发布与登录由手机浏览器自己完成。
 */

/** 墙站支持的分类（与 ai-wishing-wall 的 migrations CHECK 约束一致）。 */
export const CATEGORIES = ["life", "work", "create", "learn"] as const;
export type Category = (typeof CATEGORIES)[number];

/** 分类中文标签。 */
export const CATEGORY_LABELS: Record<Category, string> = {
  life: "生活",
  work: "工作",
  create: "创造",
  learn: "学习",
};

/** 卡片 tone 配色（照搬墙站 aesthetics：lime/pink/blue/orange/paper/lavender）。 */
export const TONES = ["lime", "pink", "blue", "orange", "paper", "lavender"] as const;
export type Tone = (typeof TONES)[number];

/**
 * API 地址（ctx.http.fetch 用）。
 * 生产：https://wish.vibeallthings.com
 * 开发：http://127.0.0.1:46272（API 服务）
 */
export const WALL_URL = "https://wish.vibeallthings.com";

/**
 * 前端网站地址（QR 码编码用，用户扫码打开的页面）。
 * 生产：https://wish.vibeallthings.com（与 API 同域）
 * 开发：http://127.0.0.1:46271（前端 dev server）
 */
export const SITE_URL = "https://wish.vibeallthings.com";

/** KV 存储的 store ID（在 manifest data.privateStores 里声明）。 */
export const STORE_ID = "wishes";
/** KV 存储里愿望列表的 key。 */
export const STORE_KEY = "items";

/** 一条愿望（本地贴的，存 KV）。 */
export interface Wish {
  id: string;
  text: string;
  category: Category;
  /** 落款（选填，空则「匿名」）。 */
  nickname: string;
  /** 随机 tone 配色。 */
  tone: Tone;
  /** 随机旋转角度（-2.5..2.5，照搬墙站）。 */
  rotate: string;
  /** 创建时间戳（ms）。 */
  createdAt: number;
  /** 支持数（远程愿望有，本地为 0）。 */
  supportCount?: number;
  /** 远程愿望的服务端状态；桌面端只读展示。 */
  supported?: boolean;
  /** 详情正文（远程愿望的 detail 字段，比 title 更长）。 */
  detail?: string;
}

/** 本地草稿文本下限。 */
export const MIN_CHARS = 3;
/** 愿望（一句话）字数上限——比墙站 200 字更紧，引导短句。 */
export const MAX_WISH_CHARS = 50;
/** 展开说说（补充说明）字数上限——与墙站 detail 3–200 字校验对齐。 */
export const MAX_DETAIL_CHARS = 200;
/** 落款字数上限。 */
export const MAX_NICKNAME = 20;

/** 墙站 /api/home 返回的愿望原始结构（取 zh 字段，插件不做双语）。 */
export interface RemoteWish {
  id: string;
  category: string;
  tone: string;
  rotate: string;
  author: { zh: string; en: string };
  title: { zh: string; en: string };
  detail: { zh: string; en: string };
  people: number;
  currentState: string;
  publishedAt: string;
  /** 远程愿望的服务端状态；匿名只读响应通常为 false。 */
  supported?: boolean;
}

/** 墙站 /api/home 返回的项目（愿望正在成真）原始结构。 */
export interface RemoteProject {
  id: string;
  /** 生命周期阶段（claimed/discovery/planning/developing/review/beta/live/maintaining/paused/cancelled/archived）。 */
  stage: string;
  title: { zh: string; en: string };
  /** 源愿望标题。 */
  wish: { zh: string; en: string };
  maker: { zh: string; en: string };
  /** 共创人数。 */
  people: number;
  /** 强调色（hex，驱动卡片配色）。 */
  color: string;
  sourceWishId?: string | null;
  visibility?: string;
  createdAt?: string;
}

/** 项目阶段中文标签（与墙站 stageLabel 对齐）。 */
export const STAGE_LABELS: Record<string, string> = {
  claimed: "已被接住",
  discovery: "发现中",
  planning: "规划中",
  developing: "开发中",
  review: "评审中",
  beta: "内测中",
  live: "已经上线",
  maintaining: "维护中",
  paused: "暂停",
  cancelled: "已取消",
  archived: "已归档",
};

/** /api/home 响应。 */
export interface HomeResponse {
  wishes?: RemoteWish[];
  projects?: RemoteProject[];
  generatedAt?: string;
}

/**
 * home 缓存 TTL（ms）。墙站 wishes 5min / projects 15min；
 * 插件数据实时性要求低（愿望随机采样），加大到 30min，缓存期内不重复请求。
 */
export const HOME_CACHE_TTL = 30 * 60_000;
/** KV 里 home 缓存的 key（与本地草稿 items 同在 wishes store，无需改 manifest）。 */
export const HOME_CACHE_KEY = "home_cache";

/** home 缓存条目（存 API 原始数据，读取时再 mapRemoteWish）。 */
export interface HomeCache {
  cachedAt: number;
  wishes: RemoteWish[];
  projects: RemoteProject[];
}

/**
 * 墙站握手端点（受众断言版，#293 提案）。旧的裸 sub 握手端点（恒真验证）
 * 随 #293 退役；此名是插件侧的临时占位，墙站定稿后只改这一处。
 */
export const WALL_AUTH_PATH = "/api/auth/plugin";

/**
 * 外脑受信 API origin——Host OAuth 配置的 token_url 同源。oauth_app 端点
 * 的 Bearer 注入只发生在这一 origin（Host network.rs 强制，跨源一律拒绝），
 * manifest 第二端点（wainao-oauth）必须与它一致。
 */
export const WAINAO_API_ORIGIN = "https://block2-api.wainao.chat";

/**
 * 外脑受众断言签发端点路径（#293 第 7 条，外脑未立项——占位名）。
 * 外脑定稿后改这里 + manifest pathPrefixes 两处；请求/响应形状见
 * getWallAssertion()。
 */
export const WAINAO_ASSERTION_PATH = "/oauth/assertion";

/**
 * 受众标识：墙站 REAI_ASSERTION_AUDIENCE 期望的 aud 值（三端一致，
 * 墙站 issue #5 定值确认；如有出入只改这里）。
 */
export const WALL_AUDIENCE = "https://wish.vibeallthings.com";

/** 握手成功后缓存的会话用户（仅展示；凭证不落插件——cookie 在 Host jar）。 */
export const SESSION_USER_KEY = "session_user";

/** 会话用户条目。displayName 来自墙站握手响应。 */
export interface SessionUser {
  displayName: string;
  linkedAt: number;
}

/** 把远程愿望映射成本地卡片用的 Wish。 */
export function mapRemoteWish(r: RemoteWish): Wish {
  return {
    id: "remote_" + r.id,
    text: r.title?.zh || r.title?.en || "",
    category: (CATEGORIES.includes(r.category as Category) ? r.category : "life") as Category,
    nickname: r.author?.zh || r.author?.en || "匿名",
    tone: (TONES.includes(r.tone as Tone) ? r.tone : "lime") as Tone,
    rotate: r.rotate || "0",
    createdAt: new Date(r.publishedAt).getTime() || Date.now(),
    supportCount: r.people || 0,
    supported: r.supported || false,
    detail: r.detail?.zh || r.detail?.en || undefined,
  };
}
