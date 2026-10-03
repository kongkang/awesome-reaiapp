/**
 * 站点皮肤。
 *
 * 只做换肤，不改结构：默认主题的导航、搜索、大纲、移动端适配都留着，
 * 上面覆一层 docs/*.html 那套设计语言（同一批 token）。
 * 两边共用一套颜色，读者在网页版和站点之间来回跳不会觉得换了产品。
 */
import DefaultTheme from "vitepress/theme";
import OpenPlatformLayout from "./OpenPlatformLayout.vue";
import "./custom.css";

export default { ...DefaultTheme, Layout: OpenPlatformLayout };
