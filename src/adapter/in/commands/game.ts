import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { GAMES } from '../../../domain/games.js';
import { setGame } from '../../../application/session.js';
import { updateTransSessionGame } from '../../../application/trans-sessions.js';
import { createLogger } from '../../out/logger.js';

const logger = createLogger('commands/game');

export const data = new SlashCommandBuilder()
  .setName('game')
  .setDescription('Set the game currently being monitored, which determines which terminology dictionary to use');

for (const game of GAMES) {
  data.addSubcommand((sub) => sub.setName(game.id).setDescription(game.name));
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const gameId = interaction.options.getSubcommand();

  const ok = await setGame(interaction.guildId!, gameId);
  if (!ok) {
    await interaction.reply({ content: "I haven't joined a voice channel yet — use /join first.", ephemeral: true });
    return;
  }
  await updateTransSessionGame(interaction.guildId!, gameId).catch((err) => logger.error({ err }, 'Failed to update trans_sessions.game_id'));

  const game = GAMES.find((g) => g.id === gameId);
  await interaction.reply({ content: `Current game set to: ${game?.name ?? gameId}`, ephemeral: true });
}
