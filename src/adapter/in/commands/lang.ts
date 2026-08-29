import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { getSession, setSourceLang, setTargetLang } from '../../../application/session.js';
import { SUPPORTED_SOURCE_LANGS } from '../../../application/ports/stt.js';
import { autocompleteLangOption, SUPPORTED_TARGET_VALUES } from './language-choices.js';

export const data = new SlashCommandBuilder()
  .setName('lang')
  .setDescription('Set source/target language for translation (neither has a default; no options shows current)')
  .addStringOption((option) =>
    option
      .setName('source')
      .setDescription('Source language: the language the speaker uses (type to search, e.g. "english" or "en-us")')
      .setRequired(false)
      .setAutocomplete(true),
  )
  .addStringOption((option) =>
    option
      .setName('target')
      .setDescription('Target language: what to translate into (type to search, e.g. "spanish" or "es")')
      .setRequired(false)
      .setAutocomplete(true),
  );

export const autocomplete = autocompleteLangOption;

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const source = interaction.options.getString('source');
  const target = interaction.options.getString('target');

  if (source && !SUPPORTED_SOURCE_LANGS.includes(source)) {
    await interaction.reply({
      content: `Unrecognized source language: "${source}". Pick one from the autocomplete suggestions while typing.`,
      ephemeral: true,
    });
    return;
  }
  if (target && !SUPPORTED_TARGET_VALUES.includes(target)) {
    await interaction.reply({
      content: `Unrecognized target language: "${target}". Pick one from the autocomplete suggestions while typing.`,
      ephemeral: true,
    });
    return;
  }

  const session = await getSession(interaction.guildId!);
  if (!session) {
    await interaction.reply({ content: "I haven't joined a voice channel yet - use /join first.", ephemeral: true });
    return;
  }

  if (source) await setSourceLang(interaction.guildId!, source);
  if (target) await setTargetLang(interaction.guildId!, target);

  const updatedSession = (await getSession(interaction.guildId!)) ?? session;
  await interaction.reply({
    content:
      `Current settings - source: ${updatedSession.sourceLang ?? '(not set - translation is paused until you set one)'}, ` +
      `target: ${updatedSession.targetLang ?? '(not set - translation is paused until you set one)'}. ` +
      'Tip: `/config source:<language> target:<language> game:<game>` sets everything at once.',
    ephemeral: true,
  });
}
