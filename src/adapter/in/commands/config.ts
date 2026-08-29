import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { getSession, setSourceLang, setTargetLang, setGame } from '../../../application/session.js';
import { GAMES } from '../../../domain/games.js';
import { SUPPORTED_SOURCE_LANGS } from '../../../application/ports/stt.js';
import { autocompleteLangOption, SUPPORTED_TARGET_VALUES } from './language-choices.js';

const GAME_CHOICES = GAMES.map((game) => ({ name: game.name, value: game.id }));

export const data = new SlashCommandBuilder()
  .setName('config')
  .setDescription('Set source language, target language, and game all at once — the required step after /join')
  .addStringOption((option) =>
    option
      .setName('source')
      .setDescription('Source language: the language the speaker uses (type to search, e.g. "english" or "en-us")')
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addStringOption((option) =>
    option
      .setName('target')
      .setDescription('Target language: what to translate into (type to search, e.g. "spanish" or "es")')
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addStringOption((option) =>
    option
      .setName('game')
      .setDescription('Which game is being played, to select the matching terminology dictionary')
      .setRequired(false)
      .addChoices(...GAME_CHOICES),
  );

export const autocomplete = autocompleteLangOption;

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const source = interaction.options.getString('source', true);
  const target = interaction.options.getString('target', true);
  const gameId = interaction.options.getString('game');

  if (!SUPPORTED_SOURCE_LANGS.includes(source)) {
    await interaction.reply({
      content: `Unrecognized source language: "${source}". Pick one from the autocomplete suggestions while typing.`,
      ephemeral: true,
    });
    return;
  }
  if (!SUPPORTED_TARGET_VALUES.includes(target)) {
    await interaction.reply({
      content: `Unrecognized target language: "${target}". Pick one from the autocomplete suggestions while typing.`,
      ephemeral: true,
    });
    return;
  }

  const session = await getSession(interaction.guildId!);
  if (!session) {
    await interaction.reply({ content: "I haven't joined a voice channel yet — use /join first.", ephemeral: true });
    return;
  }

  await setSourceLang(interaction.guildId!, source);
  await setTargetLang(interaction.guildId!, target);
  if (gameId) await setGame(interaction.guildId!, gameId);

  const game = gameId ? GAMES.find((g) => g.id === gameId) : session.game ? GAMES.find((g) => g.id === session.game) : undefined;
  const gameLabel = game ? game.name : 'none (general translation)';
  await interaction.reply({
    content: `Configured - source: ${source}, target: ${target}, game: ${gameLabel}. Translation is now active.`,
    ephemeral: true,
  });
}
