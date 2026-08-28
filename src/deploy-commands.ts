import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import * as join from './adapter/in/commands/join.js';
import * as leave from './adapter/in/commands/leave.js';
import * as test from './adapter/in/commands/test.js';
import * as lang from './adapter/in/commands/lang.js';
import * as game from './adapter/in/commands/game.js';
import * as reset from './adapter/in/commands/reset.js';
import * as configCommand from './adapter/in/commands/config.js';
import * as setting from './adapter/in/commands/setting.js';

// 稳定功能：验证过没问题、打算对外正式开放的命令。全局注册只会推这个列表。
const stableCommands = [
  join.data.toJSON(),
  leave.data.toJSON(),
  lang.data.toJSON(),
  game.data.toJSON(),
  reset.data.toJSON(),
  configCommand.data.toJSON(),
];

// 调试/开发中命令：只在测试服务器可见，不应该全局暴露给外部用户。
// /test 是纯粹用来验证"播放 PCM 到语音频道"链路本身通不通的调试工具，不是产品功能。
const devOnlyCommands = [
  test.data.toJSON(),
  setting.data.toJSON(),
];

const rest = new REST().setToken(config.discordToken);
const isGlobal = process.argv.includes('--global');

try {
  if (isGlobal) {
    // 全局注册：所有服务器可见，Discord 官方文档说明最多需要 1 小时传播生效。
    // 只推 stableCommands——只在需要（比如满足"发现"页面"APP 必须使用指令行"这条要求，
    // 或某个新命令验证稳定、准备正式开放）时手动跑一次。
    console.log(`Registering ${stableCommands.length} slash command(s) globally (can take up to 1 hour to propagate)...`);

    await rest.put(
      Routes.applicationCommands(config.discordClientId),
      { body: stableCommands },
    );
  } else {
    if (!config.testGuildId) {
      throw new Error('DISCORD_TEST_GUILD_ID is not set — fill in the test server Guild ID in .env first');
    }

    // 服务器专属注册：日常开发默认用这个，秒级生效。稳定命令 + 调试命令一起推，
    // 方便在测试服务器里验证全部功能（含 /test 这类不打算全局开放的调试工具）。
    const commands = [...stableCommands, ...devOnlyCommands];
    console.log(`Registering ${commands.length} slash command(s) to the test server...`);

    await rest.put(
      Routes.applicationGuildCommands(config.discordClientId, config.testGuildId),
      { body: commands },
    );
  }

  console.log('Registration complete.');
} catch (error) {
  console.error(error);
  process.exit(1);
}
