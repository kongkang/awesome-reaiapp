/**
 * AI Podcast 静态演示数据（从设计稿 POD_SERIES 原样搬来）。
 *
 * 这是「纯静态，后续再补功能」的占位界面——数据写死，没有真实音频播放。
 * 设计稿里这些数据驱动大播放器 + 剧集列表 + 侧栏迷你播放器；这里只驱动大播放器
 * （侧栏迷你播放器归宿主管，不归这个插件）。
 */
export interface Episode {
  id: string;
  title: string;
  date: string;
  sources: number;
  /** 总时长（秒）。 */
  dur: number;
}

export const POD_SERIES: Episode[] = [
  { id: "ep-0727", title: "Today's Briefing", date: "Jul 27", sources: 6, dur: 720 },
  { id: "ep-0726", title: "Saturday Digest", date: "Jul 26", sources: 4, dur: 480 },
  { id: "ep-0725", title: "Friday Wrap-up", date: "Jul 25", sources: 7, dur: 900 },
  { id: "ep-0723", title: "Mid-week Update", date: "Jul 23", sources: 5, dur: 600 },
  { id: "ep-0721", title: "Monday Brief", date: "Jul 21", sources: 6, dur: 660 },
];

/** 运行时状态（静态演示：cur 固定在 252 秒、playing 固定 false，不真播）。 */
export const POD = { idx: 0, cur: 252, playing: false };

/** 秒 → m:ss。 */
export function fmtT(s: number): string {
  s = Math.max(0, Math.round(s));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
