import { SlashCommandBuilder } from 'discord.js';
import { getSession, setSourceLang, setTargetLang } from '../../../application/session.js';

// 目前只支持中文/英文（session.js 里的系统默认是 源=zh、目标=en）。这里统一用 'zh' 这个
// ISO 码而不区分简繁——语音场景不需要在选语言的时候纠结简体/繁体，后端术语库内部用繁体
// 匹配（见 terminology.js 的 opencc 正规化）跟这里选什么字面值无关，用户不用关心这层。
const LANG_CHOICES = [
  { name: '中文 (zh)', value: 'zh' },
  { name: 'English (en)', value: 'en' },
];

export const data = new SlashCommandBuilder()
  .setName('lang')
  .setDescription('设置源语言/目标语言（默认 zh → en），两个参数都可选，只传一个就只改那个')
  .addStringOption((option) =>
    option
      .setName('source')
      .setDescription('源语言：说话人用的语言')
      .setRequired(false)
      .addChoices(...LANG_CHOICES),
  )
  .addStringOption((option) =>
    option
      .setName('target')
      .setDescription('目标语言：翻译成什么语言')
      .setRequired(false)
      .addChoices(...LANG_CHOICES),
  );

export async function execute(interaction) {
  const source = interaction.options.getString('source');
  const target = interaction.options.getString('target');

  const session = getSession(interaction.guildId);
  if (!session) {
    await interaction.reply({ content: '我还没加入语音频道，先 /join。', ephemeral: true });
    return;
  }

  // 只改传了的那个，另一个不动——两个参数都没传的话（比如就想看看现在是什么设置）
  // 也不报错，下面统一回复当前生效的完整配置。
  if (source) setSourceLang(interaction.guildId, source);
  if (target) setTargetLang(interaction.guildId, target);

  await interaction.reply({
    content: `当前设置——源语言：${session.sourceLang}，目标语言：${session.targetLang}`,
    ephemeral: true,
  });
}
