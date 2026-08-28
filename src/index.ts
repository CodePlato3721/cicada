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
import * as setting from './adapter/in/commands/setting.js';

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

// 首尾各 4 位，中间用省略号——只够肉眼核对"这是不是我刚改的那个 key"，不足以
// 让日志泄露出去的人拼出完整 key。key 未设置/异常短（不像真实 key）时不硬凑首尾，
// 直接说明原因，避免打印出误导性的半截内容。
function maskApiKey(key: string | undefined): string {
  if (!key) return '(not set)';
  if (key.length <= 8) return '(set, but too short to preview safely)';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

const commands = new Map<string, SlashCommandModule>([
  [join.data.name, join],
  [leave.data.name, leave],
  [test.data.name, test],
  [lang.data.name, lang],
  [game.data.name, game],
  [reset.data.name, reset],
  [configCommand.data.name, configCommand],
  [setting.data.name, setting],
]);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const logger = createLogger('index');

logger.info(generateDependencyReport());

// 排查过一次 STT 报错疑似 API key 问题——dotenv 只在进程启动这一刻读一次 .env
// （见 config.ts 顶部的 import 'dotenv/config'），没有热重载，改完 .env 忘记
// `pm2 restart` 的话运行中的进程还是拿着旧 key，光看 .env 文件内容看不出这个
// 进程实际读到的是哪个。这里只打印首尾各 4 位，不是完整 key——日志会被 pm2/
// 以后可能接的日志平台长期保存，不适合把完整密钥明文写进去，首尾 4 位够跟
// .env 里的值肉眼核对是不是同一个了。
logger.info({ deepgramApiKeyPreview: maskApiKey(config.deepgramApiKey) }, 'Deepgram API key loaded');

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
