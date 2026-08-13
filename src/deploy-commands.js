import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import * as join from './adapter/in/commands/join.js';
import * as leave from './adapter/in/commands/leave.js';
import * as test from './adapter/in/commands/test.js';
import * as source from './adapter/in/commands/source.js';

const commands = [join.data.toJSON(), leave.data.toJSON(), test.data.toJSON(), source.data.toJSON()];

const rest = new REST().setToken(config.discordToken);

try {
  if (!config.testGuildId) {
    throw new Error('DISCORD_TEST_GUILD_ID 未设置，先在 .env 里填上测试服务器的 Guild ID');
  }

  console.log(`正在向测试服务器注册 ${commands.length} 个斜杠命令...`);

  await rest.put(
    Routes.applicationGuildCommands(config.discordClientId, config.testGuildId),
    { body: commands },
  );

  console.log('注册完成。');
} catch (error) {
  console.error(error);
  process.exit(1);
}
