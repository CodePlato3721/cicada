// 术语库支持的游戏列表——新增游戏在这里加一条、并建一个对应的
// src/domain/terminology/<id>.json 词典文件就行（文件不存在 terminology.js 会在
// 启动时报错）。/game 命令的子命令列表也是从这份列表生成的，不要在别处写死游戏名。
export const GAMES = [
  { id: 'whiteout', name: 'Whiteout Survival' },
];

export function isValidGame(id) {
  return GAMES.some((game) => game.id === id);
}
