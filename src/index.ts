import { Client, GatewayIntentBits, Events, type ChatInputCommandInteraction, type AutocompleteInteraction } from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import { config } from './config.js';
import { createLogger } from './adapter/out/logger.js';
import { ensureRedisReady } from './adapter/out/redis/client.js';
import { ensureDatabaseReady } from './adapter/out/db/client.js';
import * as join from './adapter/in/commands/join.js';
import * as leave from './adapter/in/commands/leave.js';
import * as test from './adapter/in/commands/test.js';
import * as lang from './adapter/in/commands/lang.js';
import * as game from './adapter/in/commands/game.js';
import * as reset from './adapter/in/commands/reset.js';
import * as configCommand from './adapter/in/commands/config.js';

// 每个命令模块的公共形状——只关心 index.js 自己用得到的几个导出（data.name 用来注册进
// 下面的 Map，execute 用来分发 interaction），不关心各命令内部具体用了哪些 SlashCommandBuilder
// 选项/子命令，那是各命令自己的事。autocomplete 是可选的——只有用了 setAutocomplete(true)
// 的选项的命令才需要导出它（目前是 lang.js/config.js 的 source 选项，见
// language-choices.js），其他命令不用管这个字段。
interface SlashCommandModule {
  data: { name: string };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

const commands = new Map<string, SlashCommandModule>([
  [join.data.name, join],
  [leave.data.name, leave],
  [test.data.name, test],
  [lang.data.name, lang],
  [game.data.name, game],
  [reset.data.name, reset],
  [configCommand.data.name, configCommand],
]);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const logger = createLogger('index');

logger.info(generateDependencyReport());

await ensureRedisReady();
logger.info('Redis connection ready');
await ensureDatabaseReady();
logger.info('Database connection ready');

client.once(Events.ClientReady, (readyClient) => {
  logger.info(`Online, logged in as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  // autocomplete 是独立的一种 interaction 类型（用户在选项框里打字的过程中触发，
  // 不是提交命令）——跟下面 isChatInputCommand() 那条分支互斥，得单独判断、单独分发，
  // 不能指望走同一条 execute() 路径。目前只有 source 选项（lang.js/config.js）用得上，
  // 命令没导出 autocomplete 就直接跳过，不报错。
  if (interaction.isAutocomplete()) {
    const command = commands.get(interaction.commandName);
    if (!command?.autocomplete) return;
    try {
      await command.autocomplete(interaction);
    } catch (error) {
      logger.error({ err: error, command: interaction.commandName }, `Error handling autocomplete for ${interaction.commandName}`);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    logger.error({ err: error, command: interaction.commandName }, `Error executing command ${interaction.commandName}`);
  }
});

client.login(config.discordToken);
