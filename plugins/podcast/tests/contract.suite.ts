import { defineContractSuite } from "@reai/app-test/v1";

/**
 * 合同套件：覆盖 装→启用→卸载 的基础路径。
 *
 * AI Podcast 是纯静态演示（数据写死、不联网），无 commands / intents，
 * 唯一 surface 是 main；播放进度条的 setInterval 必须随 unmount 释放。
 * 语言：合同 Host 默认中文，本套件对实际文案做 zh/en 双语语义断言，
 * 并验证 Host 切语言时视图原地更新（同一节点、状态保留）。
 */
export default defineContractSuite({
  appDirectory: "..",
  hostApi: "1.19.0",
  expect: {
    surfaces: ["main"],
    commands: [],
    intents: [],
    readySurfaces: ["main"],
    forbiddenNetworkRequests: "all",
    noResourcesAfterUnmount: true,
  },
  scenarios: [
    {
      name: "main surface 能挂载并 ready",
      async run({ host, expect }) {
        const main = await host.openSurface("main");
        expect(main).toBeOpen();
      },
    },
    {
      name: "Host 标题栏动作打开往期节目",
      async run({ host }) {
        const main = await host.openSurface("main");
        if (!main.root) throw new Error("DOM 环境不可用");
        await host.sendIntent(main.surfaceMountId, {
          source: "host.titlebarAction",
          actionId: "history",
          deliveryId: "contract-history",
          payload: { type: "toggle-history" },
        });
        if (!main.root.querySelector(".pod-drawer.open")) {
          throw new Error("往期标题栏动作没有打开节目抽屉");
        }
      },
    },

    {
      /* B9-29/30 + B9-36（V1.7.0）：页头撤除、「往期」只走 titlebar；提要区三卡。
       * 语言包回归：同一套结构断言在 zh 与 en 下都成立；切语言原地更新节点，
       * 节目标题等演示数据保持原文。 */
      name: "页头已撤（B9-29/30），提要区三卡在场（B9-36），中英文语义一致",
      async run({ host }) {
        const main = await host.openSurface("main");
        const root = main.root;
        if (!root) throw new Error("DOM 环境不可用");
        if (root.querySelector(".pod-page-header")) {
          throw new Error("B9-29/30：pod-page-header 应已撤除（App 身份由 Host 承载）");
        }
        if (root.querySelector(".pod-sources")) {
          throw new Error("B9-30：Past episodes 页内按钮应已撤除（只走 titlebar）");
        }
        const assertStructure = (expectation: {
          kicker: string;
          title: string;
          cards: ReadonlyArray<readonly [string, string]>;
          drawerTitle: string;
          closeLabel: string;
        }) => {
          const kicker = root.querySelector(".pod-notes-kicker");
          if (kicker?.textContent !== expectation.kicker) {
            throw new Error(`B9-36：提要区 kicker 应为「${expectation.kicker}」，实际「${kicker?.textContent}」`);
          }
          if (!kicker.parentElement?.querySelector('[data-tbc-id="tbc.podcast-content"]')) {
            throw new Error("B9-36：静态提要缺少逐选项 TBC 标记");
          }
          const cards = root.querySelectorAll(".pod-note-card");
          if (cards.length !== 3) {
            throw new Error(`B9-36：note-card 应为 3 张，实际 ${cards.length}`);
          }
          if (root.querySelector(".pod-notes-title")?.textContent !== expectation.title) {
            throw new Error(`B9-36：提要区标题应为「${expectation.title}」`);
          }
          const copies = Array.from(cards).map((card) => card.textContent);
          for (const [head, copy] of expectation.cards) {
            if (!copies.some((text) => text === `${head}${copy}`)) {
              throw new Error(`B9-36：note-card 文案不对（${head}）`);
            }
          }
          const drawerTitle = root.querySelector(".pod-drawer-title");
          if (!drawerTitle?.textContent?.startsWith(expectation.drawerTitle)) {
            throw new Error(`抽屉标题应为「${expectation.drawerTitle}」，实际「${drawerTitle?.textContent}」`);
          }
          const close = root.querySelector(".pod-drawer-close");
          if (close?.getAttribute("aria-label") !== expectation.closeLabel) {
            throw new Error(`关闭按钮 aria-label 应为「${expectation.closeLabel}」`);
          }
        };

        assertStructure({
          kicker: "本期提要",
          title: "今天值得继续听的三条线索",
          cards: [
            ["产品", "本周发布变化、用户反馈与下一步优先级。"],
            ["技术", "模型、工具链与开发者生态里值得关注的更新。"],
            ["团队", "会议结论、待确认事项与今天需要跟进的人。"],
          ],
          drawerTitle: "往期节目",
          closeLabel: "关闭剧集列表",
        });

        // Host 切英文：同一节点原地更新为英文语义；演示数据保留原文。
        const kickerNode = root.querySelector(".pod-notes-kicker");
        host.setLocale("en");
        if (root.querySelector(".pod-notes-kicker") !== kickerNode) {
          throw new Error("切语言不应重建提要区节点");
        }
        assertStructure({
          kicker: "Show notes",
          title: "Three threads worth following up on today",
          cards: [
            ["Product", "This week's release changes, user feedback and the next priorities."],
            ["Tech", "Updates worth noting across models, tooling and the developer ecosystem."],
            ["Team", "Meeting decisions, items to confirm and the people to follow up with today."],
          ],
          drawerTitle: "Episodes",
          closeLabel: "Close episode list",
        });
        if (!root.querySelector(".pod-title")?.textContent?.includes("Today's Briefing")) {
          throw new Error("切语言不得改写节目内容数据（集标题）");
        }
        if ((root.textContent ?? "").match(/[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/)) {
          throw new Error("英文界面残留中文可见文案");
        }

        // 切回中文，确认可逆。
        host.setLocale("zh");
        if (kickerNode?.textContent !== "本期提要") {
          throw new Error("切回中文后提要区 kicker 未恢复");
        }
      },
    },
  ],
});
