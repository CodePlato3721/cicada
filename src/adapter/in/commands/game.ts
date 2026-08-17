import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { GAMES } from '../../../domain/games.js';
import { setGame } from '../../../application/session.js';

// 每个游戏是一个子命令，而不是一个字符串选项——这样 /game 打出来直接弹的是
// 游戏名列表本身（/game whiteout），不用先输入一个选项名（/game game:whiteout）。
// 代价：加新游戏要多写一行 addSubcommand，但反正 games.js 那份列表本身也要改，
// 不算额外成本。
export const data = new SlashCommandBuilder()
  .setName('game')
  .setDescription('Set the game currently being monitored, which determines which terminology dictionary to use');

for (const game of GAMES) {
  data.addSubcommand((sub) => sub.setName(game.id).setDescription(game.name));
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const gameId = interaction.options.getSubcommand();

  // 这几个命令只在语音频道所在的服务器里被调用（用户先 /join 一个服务器的语音频道），
  // guildId 在这个上下文里必然存在——用 ! 断言，跟 pipeline.js 里 session! 是同一个
  // 惯例：类型层面标注一个运行时已经成立的不变量，不是新增判断分支。
  const ok = setGame(interaction.guildId!, gameId);
  if (!ok) {
    await interaction.reply({ content: "I haven't joined a voice channel yet — use /join first.", ephemeral: true });
    return;
  }

  const game = GAMES.find((g) => g.id === gameId);
  await interaction.reply({ content: `Current game set to: ${game?.name ?? gameId}`, ephemeral: true });
}
