import { SlashCommandBuilder } from 'discord.js';
import { GAMES } from '../../../domain/games.js';
import { setGame } from '../../../application/session.js';

// 每个游戏是一个子命令，而不是一个字符串选项——这样 /game 打出来直接弹的是
// 游戏名列表本身（/game whiteout），不用先输入一个选项名（/game game:whiteout）。
// 代价：加新游戏要多写一行 addSubcommand，但反正 games.js 那份列表本身也要改，
// 不算额外成本。
export const data = new SlashCommandBuilder()
  .setName('game')
  .setDescription('设置当前监听用的游戏，决定用哪套黑话词典');

for (const game of GAMES) {
  data.addSubcommand((sub) => sub.setName(game.id).setDescription(game.name));
}

export async function execute(interaction) {
  const gameId = interaction.options.getSubcommand();

  const ok = setGame(interaction.guildId, gameId);
  if (!ok) {
    await interaction.reply({ content: '我还没加入语音频道，先 /join。', ephemeral: true });
    return;
  }

  const game = GAMES.find((g) => g.id === gameId);
  await interaction.reply({ content: `当前游戏已设为：${game?.name ?? gameId}`, ephemeral: true });
}
