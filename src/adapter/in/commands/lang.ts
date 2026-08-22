import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { getSession, setSourceLang, setTargetLang } from '../../../application/session.js';
import { SOURCE_LANG_CHOICES, TARGET_LANG_CHOICES } from './language-choices.js';

export const data = new SlashCommandBuilder()
  .setName('lang')
  .setDescription('Set source/target language for translation (neither has a default; no options shows current)')
  .addStringOption((option) =>
    option
      .setName('source')
      .setDescription('Source language: the language the speaker uses')
      .setRequired(false)
      .addChoices(...SOURCE_LANG_CHOICES),
  )
  .addStringOption((option) =>
    option
      .setName('target')
      .setDescription('Target language: what to translate into (limited by TTS voice coverage)')
      .setRequired(false)
      .addChoices(...TARGET_LANG_CHOICES),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const source = interaction.options.getString('source');
  const target = interaction.options.getString('target');

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
