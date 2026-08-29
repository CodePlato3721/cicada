import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { getSession, setSourceLang, setTargetLang, setGame } from '../../../application/session.js';
import { GAMES } from '../../../domain/games.js';
import { SUPPORTED_SOURCE_LANGS } from '../../../application/ports/stt.js';
import { autocompleteLangOption, SUPPORTED_TARGET_VALUES } from './language-choices.js';

// /join 之后必须调用的那一步——source/target 语言 + game 一次性设完，取代原来
// "必须先 /lang target:<language>" 那条路径。source 和 target 这里都是必填：
// 源语言曾经有"不设置就靠 STT 自动检测锁定"的兜底，但实测检测准确度太低（极短音频
// 经常判错语种，见 CLAUDE.md「术语检测用哪种语言扫描」的历史记录），已经把那条自动
// 检测逻辑从 pipeline.js 里整个删掉——现在源语言跟目标语言一样，没有任何默认值/兜底，
// 必须显式设置一次。game 保留可选，不传就沿用 session 当前值（/join 时已经默认成
// games.js 第一项）。
//
// /lang 和 /game 两个命令还在，留给配置好之后只想单独调整某一项的场景；/config 是
// 首次配置时的推荐入口，一条命令把三样都设好。
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

// source 和 target 都改成 autocomplete 之后（见 language-choices.js 顶部注释——source
// 79 个 locale、target 54 个语言，都超过 Discord addChoices 25 个上限），/lang 和
// /config 共用同一个过滤逻辑。
export const autocomplete = autocompleteLangOption;

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const source = interaction.options.getString('source', true);
  const target = interaction.options.getString('target', true);
  const gameId = interaction.options.getString('game');

  // autocomplete 不像 addChoices，Discord 不会在服务端强制最终提交值必须来自候选列表
  // （见 language-choices.js 的 autocompleteLangOption 注释）——这里必须手动校验一遍。
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

  // guildId 必然存在，见 game.js 同样的 ! 断言惯例。
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
