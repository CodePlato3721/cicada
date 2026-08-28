import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';

// 调试用的最简命令——排查 /config 在某些服务器里悄悄消失这个问题的临时手段：
// 从一个啥都不做、只回一行文字的最简命令开始，之后把 config.ts 的功能一点点搬过来，
// 每搬一步部署一次，看具体哪一步开始命令又不见了。跟 /test 一样是调试工具，不是产品
// 功能，只在测试服务器专属注册（deploy-commands.ts 的 devOnlyCommands），不进全局列表。
export const data = new SlashCommandBuilder()
  .setName('setting')
  .setDescription('Debug command - does nothing yet, just replies hello');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({ content: 'hello', ephemeral: true });
}
