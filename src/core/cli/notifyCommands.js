/**
 * eanyra notify status            what is configured and what is wrong now
 * eanyra notify telegram-chat     find the chat that wrote to the bot, enable Telegram alerts
 * eanyra notify discord           store a Discord webhook in the vault, enable Discord alerts
 * eanyra notify test              send a test message to every enabled channel
 * eanyra notify check             detect problems now and send what is new
 * eanyra notify off <channel>     disable a channel
 */

import { PATHS } from '../../config/app.config.js';
import { DEFAULT_SESSION } from '../../config/accountConfig.js';
import { loadNotifyConfig, updateNotifyConfig } from '../../config/notifyConfig.js';
import { askSecret, askText } from '../../shared/prompt.js';
import { print } from '../../shared/utils.js';
import database from '../teapot/database.js';
import { Credentials } from '../secrets/Credentials.js';
import { sequelizeExecutor } from '../services/sql.js';
import { assertDiscordWebhook, telegramChatsOf } from '../notify/channels.js';
import { buildChannels, runProblemChecks } from '../notify/index.js';

export function registerNotifyCommands(program) {
  const notify = program.command('notify').description('Alerts about problems via a Telegram bot or a Discord webhook');

  notify.command('status')
    .description('Show configured channels and the problems detected right now (sends nothing)')
    .action(async () => {
      const config = await loadNotifyConfig();
      if (!config) print(`Alerts are not configured (${PATHS.notificationsConfig}). Use \`notify telegram-chat\` or \`notify discord\`.`, 'warning');
      else {
        print(`Telegram: ${config.telegram?.enabled ? `on → chat ${config.telegram.chat_id} via bot "${config.telegram.bot}"` : 'off'}`, 'info');
        print(`Discord:  ${config.discord?.enabled ? `on → webhook "${config.discord.webhook}"` : 'off'}`, 'info');
        print(`Rules: ${JSON.stringify(config.rules)}`, 'system');
      }
      const credentials = await Credentials.open();
      const { problems } = await runProblemChecks({ db: sequelizeExecutor(database.sequelize), credentials, config: null });
      if (!problems.length) print('No problems right now.', 'success');
      for (const problem of problems) print(problem.text, 'warning');
    });

  notify.command('telegram-chat')
    .description('Send /start to your bot first; this finds that chat and enables Telegram alerts')
    .option('--bot <name>', 'Bot stored with `secrets set telegram-bot <name>`', DEFAULT_SESSION)
    .action(async ({ bot }) => {
      const credentials = await Credentials.open();
      const token = credentials.botToken(bot);
      if (!token) throw new Error(`No token for bot "${bot}". Run \`npm run nyra -- secrets set telegram-bot ${bot}\`.`);
      const chats = await telegramChatsOf(token);
      if (!chats.length) throw new Error('The bot has no messages yet. Open your bot in Telegram, press Start (or send any message), then run this again.');
      let chat = chats[0];
      if (chats.length > 1) {
        chats.forEach((item, i) => print(`${i + 1}. ${item.title || '(no name)'} · ${item.type} · ${item.id}`, 'data'));
        const pick = Number(await askText(`Which chat receives alerts? [1-${chats.length}] `));
        chat = chats[pick - 1];
        if (!chat) throw new Error('No chat selected.');
      }
      await updateNotifyConfig({ telegram: { enabled: true, bot, chat_id: chat.id } });
      print(`Telegram alerts → ${chat.title || chat.id} (${chat.type}). Try \`npm run nyra -- notify test\`.`, 'success');
    });

  notify.command('discord')
    .description('Store a Discord webhook URL (hidden prompt) and enable Discord alerts')
    .option('--name <name>', 'Webhook name in the vault', DEFAULT_SESSION)
    .action(async ({ name }) => {
      const credentials = await Credentials.open();
      if (!credentials.vault) throw new Error('Discord webhooks are stored in the vault. Run `npm run nyra -- vault init` first.');
      const url = (await askSecret('Discord webhook URL: ')).trim();
      assertDiscordWebhook(url);
      await credentials.vault.set('discord-webhook', name, { url });
      await updateNotifyConfig({ discord: { enabled: true, webhook: name } });
      print('Discord alerts enabled. Try `npm run nyra -- notify test`.', 'success');
    });

  notify.command('off <channel>')
    .description('Disable telegram or discord alerts (settings are kept)')
    .action(async channel => {
      if (!['telegram', 'discord'].includes(channel)) throw new Error('Channel must be telegram or discord.');
      const config = await loadNotifyConfig();
      if (!config?.[channel]) throw new Error(`${channel} alerts are not configured.`);
      await updateNotifyConfig({ [channel]: { ...config[channel], enabled: false } });
      print(`${channel} alerts disabled.`, 'success');
    });

  notify.command('test')
    .description('Send a test message to every enabled channel')
    .action(async () => {
      const config = await loadNotifyConfig();
      if (!config) throw new Error('Alerts are not configured. Use `notify telegram-chat` or `notify discord`.');
      const { channels, problems } = buildChannels(config, await Credentials.open());
      for (const problem of problems) print(problem, 'error');
      for (const channel of channels) {
        try {
          await channel.send('EANyra: тестове сповіщення. Сюди приходитимуть повідомлення про проблеми зі збором і логінами.');
          print(`${channel.name}: delivered.`, 'success');
        } catch (error) {
          print(`${channel.name}: ${error.message}`, 'error');
        }
      }
      if (!channels.length && !problems.length) print('No channel is enabled.', 'warning');
    });

  notify.command('check')
    .description('Detect problems now and send new, repeated and resolved ones')
    .action(async () => {
      const { configured, problems, result, setupProblems } = await runProblemChecks({
        db: sequelizeExecutor(database.sequelize), credentials: await Credentials.open(),
      });
      print(`${problems.length} problem(s) detected.`, problems.length ? 'warning' : 'success');
      if (!configured) {
        print('Alerts are not configured, nothing was sent.', 'warning');
        return;
      }
      for (const message of [...(setupProblems ?? []), ...result.failed]) print(message, 'error');
      print(result.sent ? `Sent via ${result.delivered.join(', ')}.` : 'Nothing new to send.', 'info');
    });
}
