import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import * as join from './adapter/in/commands/join.js';
import * as leave from './adapter/in/commands/leave.js';
import * as test from './adapter/in/commands/test.js';
import * as lang from './adapter/in/commands/lang.js';
import * as game from './adapter/in/commands/game.js';
import * as reset from './adapter/in/commands/reset.js';
import * as configCommand from './adapter/in/commands/config.js';

const stableCommands = [
  join.data.toJSON(),
  leave.data.toJSON(),
  lang.data.toJSON(),
  game.data.toJSON(),
  reset.data.toJSON(),
  configCommand.data.toJSON(),
];

const devOnlyCommands = [
  test.data.toJSON(),
];

const rest = new REST().setToken(config.discordToken);
const isGlobal = process.argv.includes('--global');

try {
  if (isGlobal) {
    console.log(`Registering ${stableCommands.length} slash command(s) globally (can take up to 1 hour to propagate)...`);

    await rest.put(
      Routes.applicationCommands(config.discordClientId),
      { body: stableCommands },
    );
  } else {
    if (!config.testGuildId) {
      throw new Error('DISCORD_TEST_GUILD_ID is not set — fill in the test server Guild ID in .env first');
    }

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
