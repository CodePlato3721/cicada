// 术语库抓取的声明式配置——新增一个要抓的分类（装备、联盟玩法……）在这个数组里加
// 一条就行，不用写新代码。设计背景见 CLAUDE.md「游戏黑话/专有名词术语库」一节。
//
// listUrl 只需要给英文入口页：中文页面靠每个英文详情页里的 hreflang="tw" 互链自动
// 找到，不用单独配置中文 URL（这是两次实操验证过唯一可靠的中英文配对方式，见
// scripts/lib/wiki-scraper.js 的 resolveZhName）。
//
// 目前只覆盖 whiteoutsurvival.wiki 这一个站点的页面结构（WordPress 主题，卡片和
// hreflang 的 HTML 模式全站一致）。以后如果要抓别的 wiki，页面结构大概率不一样，
// 到时候再看要不要扩展 wiki-scraper.js，不要现在就为了"支持任意网站"过度设计。
export const SOURCES = [
  {
    id: 'heroes',
    game: 'whiteout',
    idPrefix: 'HERO',
    listUrl: 'https://www.whiteoutsurvival.wiki/heroes/',
  },
  {
    id: 'events',
    game: 'whiteout',
    idPrefix: 'EVENT',
    listUrl: 'https://www.whiteoutsurvival.wiki/events/',
  },
  // research/alliance-tech 两个页面的界面比 heroes/events 复杂：上面有分类 Tab
  // （Battle/Growth/Economy...），左边还有独立的 Tier 层级筛选，两个维度可以分别切换。
  // 抓取前必须两个维度都看过，不能只确认其中一边就假设"看到的就是全部"——比如只切
  // 过左边 Tier、没切过上面的 Tab，可能漏掉别的分类下的条目。已经用 WebFetch 对
  // research 验证过：不管当前 Tab/Tier 选哪个，全部条目其实是一次性服务端渲染在
  // 同一份 HTML 里的（Tab/Tier 只是前端展示效果，不是重新请求数据），所以
  // fetchListPage() 一次抓取就能拿到所有分类的条目，不用管这层 UI。alliance-tech
  // 还没验证，抓之前应该重复同样的检查（WebFetch 看原始 HTML，确认所有 Tab 下的条目
  // 是否都在同一份响应里、每条是否有独立详情页链接）。
  {
    id: 'research',
    game: 'whiteout',
    idPrefix: 'RESEARCH',
    listUrl: 'https://www.whiteoutsurvival.wiki/research/',
  },
  {
    id: 'buildings',
    game: 'whiteout',
    idPrefix: 'BUILDING',
    listUrl: 'https://www.whiteoutsurvival.wiki/buildings/',
  },
  {
    id: 'items',
    game: 'whiteout',
    idPrefix: 'ITEM',
    listUrl: 'https://www.whiteoutsurvival.wiki/items/',
  },
  {
    id: 'pets',
    game: 'whiteout',
    idPrefix: 'PET',
    listUrl: 'https://www.whiteoutsurvival.wiki/pets/',
  },
  {
    id: 'experts',
    game: 'whiteout',
    idPrefix: 'EXPERT',
    listUrl: 'https://www.whiteoutsurvival.wiki/experts/',
  },
  // 跟 research 同款"分类 Tab + Tier 层级"两层切换界面，还没验证过是否也是全部
  // 服务端渲染在同一份 HTML 里——抓之前重复 research 那条注释里的检查步骤。
  {
    id: 'alliance-tech',
    game: 'whiteout',
    idPrefix: 'ALLYTECH',
    listUrl: 'https://www.whiteoutsurvival.wiki/alliance-tech/',
  },
];

export function getSource(id) {
  const source = SOURCES.find((s) => s.id === id);
  if (!source) {
    throw new Error(`未知的抓取分类 "${id}"，可选：${SOURCES.map((s) => s.id).join(', ')}`);
  }
  return source;
}
