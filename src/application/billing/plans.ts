import pricingPlans from '../../config/pricing-plans.json' with { type: 'json' };
import type { BillingPlanId } from './types.js';

export interface BillingPlan {
  id: BillingPlanId;
  name: string;
  monthlyPriceUsd: number;
  // 2026-08-23 改回来：8/14 曾经改成"今天挂在语音频道里的连接时长"（墙钟时间，不管有
  // 没有人说话，靠 connection-usage-tracker.ts 每 5 分钟打点）。connection-usage-tracker.ts
  // 已删除——不再需要一个独立定时器持续戳 Postgres，限额语义改回"今天 STT 实际识别过的
  // 语音时长"，随每次 STT 调用返回后原子累加（session.ts 的 incrementSttSecondsUsed），
  // 不再需要单独的定时任务。
  dailySttSecondsLimit: number | null;
  dailyTextCharsLimit: number | null;
  allowedLanguageCodes: Set<string> | null;
}

// 2026-08-26：套餐详情不再是这里手写的常量对象，改成从 src/config/pricing-plans.json
// 转换而来——那份 JSON 是 landing 页价格卡片和这里运行时限额判断共用的同一份 source of
// truth（新增/调整套餐只改那一份文件，价格页和限额逻辑自动同步，不会出现"官网写着 30
// 分钟/天，实际后端按另一个数字拦截"这种两处不一致）。这里只做单位/形状转换：
// dailyMinutes（人读的分钟数）-> dailySttSecondsLimit（限额判断内部按秒算，见
// billing-service.ts）；languages（null 代表不限）-> Set（O(1) 查找，见
// checkTranslateAllowed）。
export const BILLING_PLANS: Record<BillingPlanId, BillingPlan> = Object.fromEntries(
  pricingPlans.plans.map((plan) => [
    plan.id,
    {
      id: plan.id,
      name: plan.name,
      monthlyPriceUsd: plan.monthlyPriceUsd,
      dailySttSecondsLimit: plan.dailyMinutes === null ? null : plan.dailyMinutes * 60,
      dailyTextCharsLimit: plan.dailyTextChars,
      allowedLanguageCodes: plan.languages === null ? null : new Set(plan.languages),
    },
  ]),
) as Record<BillingPlanId, BillingPlan>;

// 默认套餐由 pricing-plans.json 里 isDefault: true 的那一条决定，不是"数组第一项"这种
// 隐式约定——default 是个业务决策（"guild 第一次出现、还没人为它设置套餐"时给它什么待遇），
// 跟这条数据在数组里排第几位（纯粹是价格卡片在 landing 页上从左到右的展示顺序）是两件不
// 相关的事，绑在一起迟早会因为"调整了展示顺序"意外改变默认套餐。
//
// 当前 isDefault 标在 beta 套餐上：产品还在 beta 测试期、商业化/订阅收款这层本身还不在
// 当前范围内（见 CLAUDE.md），所以现在每个新出现的 guild 先按 beta 套餐的限额招待
// （2 小时/天、55 种语言、20000 字符/天），等 beta 期结束、正式定价上线后再把 isDefault
// 挪到某个付费档（大概率是 starter）、beta 这条本身可能直接从列表里下架——到时候只改
// JSON，不需要再碰这段代码。找不到任何一条 isDefault: true 时兜底用数组第一项，避免
// JSON 手滑漏标时直接在启动期报错崩掉。
export const DEFAULT_PLAN_ID: BillingPlanId = (pricingPlans.plans.find((plan) => plan.isDefault) ?? pricingPlans.plans[0]).id;

export const DEFAULT_PLAN: BillingPlan = BILLING_PLANS[DEFAULT_PLAN_ID];
