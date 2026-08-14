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
];

export function getSource(id) {
  const source = SOURCES.find((s) => s.id === id);
  if (!source) {
    throw new Error(`未知的抓取分类 "${id}"，可选：${SOURCES.map((s) => s.id).join(', ')}`);
  }
  return source;
}
