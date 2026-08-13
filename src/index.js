import { Client, GatewayIntentBits, Events } from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import { config } from './config.js';
import * as join from './adapter/in/commands/join.js';
import * as leave from './adapter/in/commands/leave.js';
import * as test from './adapter/in/commands/test.js';
import * as lang from './adapter/in/commands/lang.js';
import * as game from './adapter/in/commands/game.js';

const commands = new Map([
  [join.data.name, join],
  [leave.data.name, leave],
  [test.data.name, test],
  [lang.data.name, lang],
  [game.data.name, game],
]);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

console.log(generateDependencyReport());

client.once(Events.ClientReady, (readyClient) => {
  console.log(`已上线，登录为 ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`执行命令 ${interaction.commandName} 时出错：`, error);
  }
});

client.login(config.discordToken);
