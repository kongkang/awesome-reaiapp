/** 视图层共享类型（避免 view 直接依赖 bridge/agent-loop 的实现细节）。 */
import type { ComputerState, PermissionsStatus } from "./computer-bridge";

export type { ComputerState, PermissionsStatus };

export interface StepLike {
  step: number;
  thought?: string;
  action: {
    action: string;
    x?: number;
    y?: number;
    text?: string;
    key?: string;
    dy?: number;
    detail?: string;
  };
  ok: boolean;
  error?: string;
}
