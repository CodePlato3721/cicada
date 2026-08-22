import { Client, GatewayIntentBits, Events, type ChatInputCommandInteraction } from 'discord.js';
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

// 每个命令模块的公共形状——只关心 index.js 自己用得到的两个导出（data.name 用来注册进
// 下面的 Map，execute 用来分发 interaction），不关心各命令内部具体用了哪些 SlashCommandBuilder
// 选项/子命令，那是各命令自己的事。
interface SlashCommandModule {
  data: { name: string };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
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
