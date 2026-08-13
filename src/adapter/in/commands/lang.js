import { SlashCommandBuilder } from 'discord.js';
import { setSourceLang } from '../../../application/session.js';

export const data = new SlashCommandBuilder()
  .setName('lang')
  .setDescription('手动设置说话人的源语言，帮 STT 提升准确率（不设置就自动检测语种）')
  .addStringOption((option) =>
    option
      .setName('source')
      .setDescription('说话人使用的语言')
      .setRequired(true)
      .addChoices(
        { name: '中文 (zh)', value: 'zh' },
        { name: 'English (en)', value: 'en' },
        { name: '自动检测', value: 'auto' },
      ),
  );

export async function execute(interaction) {
  const lang = interaction.options.getString('source', true);
  const actualLang = lang === 'auto' ? null : lang;

  const ok = setSourceLang(interaction.guildId, actualLang);
  if (!ok) {
    await interaction.reply({ content: '我还没加入语音频道，先 /join。', ephemeral: true });
    return;
  }

  await interaction.reply({
    content: actualLang ? `源语言已设为：${lang}` : '已切换为自动检测语种',
    ephemeral: true,
  });
}
