require('dotenv').config();
const http = require('http');
const { App, LogLevel } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const tokenStore = require('./tokenStore');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  logLevel: LogLevel.DEBUG,
});

// part to self generate user token for private channels 
const OAUTH_PORT = process.env.PORT || 3000;
const OAUTH_REDIRECT_URI = process.env.SLACK_REDIRECT_URI;
const CONNECT_URL =
  OAUTH_REDIRECT_URI && process.env.SLACK_CLIENT_ID
    ? `https://slack.com/oauth/v2/authorize?client_id=${process.env.SLACK_CLIENT_ID}` +
      `&user_scope=groups:read,channels:read&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}`
    : null;
const README_URL = 'https://github.com/CKacha/bday-bot#readme';

function getUserClient(userId) {
  // only for testing idk remove it later mayhsps
  const token = tokenStore.get(userId) || process.env.SLACK_USER_TOKEN;
  return token ? new WebClient(token) : null;
}

async function fetchChannelContext(botClient, inviterId, channelId) {
  const userClient = getUserClient(inviterId);
  const reader = userClient || botClient;
  try {
    const info = await reader.conversations.info({ channel: channelId });
    const members = await getChannelMembers(reader, channelId);
    return { info, members };
  } catch (err) {
    const code = err.data ? err.data.error : err.message;
    const missingAccess = ['channel_not_found', 'not_in_channel', 'missing_scope'].includes(code);
    if (!userClient && CONNECT_URL && missingAccess) {
      const needsConnectErr = new Error('needs_connect');
      needsConnectErr.needsConnect = true;
      throw needsConnectErr;
    }
    throw err;
  }
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${OAUTH_PORT}`);

    if (url.pathname !== '/slack/oauth/callback') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400);
      res.end('Missing code');
      return;
    }

    try {
      const result = await new WebClient().oauth.v2.access({
        client_id: process.env.SLACK_CLIENT_ID,
        client_secret: process.env.SLACK_CLIENT_SECRET,
        code,
        redirect_uri: OAUTH_REDIRECT_URI,
      });
      const userId = result.authed_user && result.authed_user.id;
      const userToken = result.authed_user && result.authed_user.access_token;
      if (!userId || !userToken) {
        res.writeHead(400);
        res.end("Slack didn't return a user token. Make sure the app requests user scopes.");
        return;
      }
      tokenStore.set(userId, userToken);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>Connected! You can close this tab and go back to Slack.</body></html>');
    } catch (err) {
      res.writeHead(500);
      res.end('Something went wrong connecting your account.');
    }
  })
  .listen(OAUTH_PORT, () => {
    console.log(`OAuth callback server listening on port ${OAUTH_PORT}`);
  });

async function getChannelMembers(client, channelId) {
  const members = [];
  let cursor;
  do {
    const resp = await client.conversations.members({ channel: channelId, cursor, limit: 200 });
    members.push(...resp.members);
    cursor = resp.response_metadata && resp.response_metadata.next_cursor;
  } while (cursor);
  return members;
}

async function getBotUserIds(client, userIds) {
  const botIds = new Set(['USLACKBOT']);
  for (const userId of userIds) {
    if (botIds.has(userId)) continue;
    try {
      const resp = await client.users.info({ user: userId });
      if (resp.user && resp.user.is_bot) botIds.add(userId);
    } catch (err) {
      // error handeling should probably be sent as a dm
      //do soon
    }
  }
  return botIds;
}

function defaultMessage(birthdayUserId, inviterId) {
  return (
    `:tada: <@${inviterId}> sent you an invite for <@${birthdayUserId}>'s birthday! ` +
    `Want to help plan something special? Tap *Accept* below and I'll add you to the planning channel.`
  );
}

const MAX_PREVIEW_LISTED = 40;

function buildFormBlocks({ sourceChannelId, birthdayUserId, destChannelId, messageInput }) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          'This will DM everyone in the channel you pick below (except the birthday ' +
          'person) with an invite. Anyone who accepts gets added to the planning channel you designate.',
      },
    },
    {
      type: 'input',
      block_id: 'source_block',
      label: { type: 'plain_text', text: 'Channel to invite from' },
      dispatch_action: true,
      element: {
        type: 'conversations_select',
        action_id: 'source_select',
        filter: { include: ['public', 'private'] },
        ...(sourceChannelId ? { initial_conversation: sourceChannelId } : {}),
      },
    },
    {
      type: 'input',
      block_id: 'bday_block',
      label: { type: 'plain_text', text: "Who's the birthday person?" },
      dispatch_action: true,
      element: {
        type: 'users_select',
        action_id: 'bday_select',
        ...(birthdayUserId ? { initial_user: birthdayUserId } : {}),
      },
    },
    {
      type: 'input',
      block_id: 'dest_block',
      label: { type: 'plain_text', text: 'Planning channel (the one you manage)' },
      element: {
        type: 'conversations_select',
        action_id: 'dest_select',
        filter: { include: ['public', 'private'], exclude_bot_users: true },
        ...(destChannelId ? { initial_conversation: destChannelId } : {}),
      },
    },
    {
      type: 'input',
      block_id: 'message_block',
      label: { type: 'plain_text', text: 'Message to send' },
      optional: true,
      element: {
        type: 'plain_text_input',
        action_id: 'message_input',
        multiline: true,
        placeholder: {
          type: 'plain_text',
          text: 'Leave blank to use the default birthday invite message.',
        },
        ...(messageInput ? { initial_value: messageInput } : {}),
      },
    },
  ];
}

// no tweeking okease
const notifiedAccessFailures = new Set();

async function buildPreviewBlocks(client, { sourceChannelId, birthdayUserId, inviterId, messageInput }) {
  if (!sourceChannelId) return [];

  const blocks = [{ type: 'divider' }];

  try {
    const { info, members } = await fetchChannelContext(client, inviterId, sourceChannelId);
    const sourceChannelName = info.channel.name;

    const botIds = await getBotUserIds(client, members);
    const recipients = members.filter(
      (id) => id !== birthdayUserId && id !== inviterId && !botIds.has(id)
    );

    const messageText = birthdayUserId
      ? (messageInput || '').trim() || defaultMessage(birthdayUserId, inviterId)
      : null;

    if (messageText) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Preview — this is what recipients will receive:*\n${messageText}` },
      });
    }

    const shown = recipients.slice(0, MAX_PREVIEW_LISTED);
    const extra = recipients.length - shown.length;
    const listText = shown.length
      ? shown.map((id) => `• <@${id}>`).join('\n') + (extra > 0 ? `\n_...and ${extra} more_` : '')
      : '_Nobody else in this channel to invite._';

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*The following ${recipients.length} ${recipients.length === 1 ? 'person' : 'people'} will be added (from #${sourceChannelName}):*\n${listText}`,
      },
    });
  } catch (err) {
    const dmKey = `${inviterId}:${sourceChannelId}:${err.needsConnect ? 'connect' : 'error'}`;
    const alreadyNotified = notifiedAccessFailures.has(dmKey);
    notifiedAccessFailures.add(dmKey);

    if (err.needsConnect) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            ":lock: That's a private channel I'm not in. Connect your Slack account so I can read " +
            "its members without joining it — reselect the channel here afterward to refresh this preview.",
        },
      });
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Connect your Slack account' },
            url: CONNECT_URL,
            action_id: 'connect_account',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View setup docs' },
            url: README_URL,
            action_id: 'view_readme',
          },
        ],
      });
      if (!alreadyNotified) {
        await client.chat.postMessage({
          channel: inviterId,
          text:
            `:lock: <#${sourceChannelId}> is a private channel I'm not in. Connect your Slack account, ` +
            `then reselect the channel in the /bday modal: ${CONNECT_URL}\nSetup docs: ${README_URL}`,
        });
      }
    } else {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:warning: Couldn't load a preview for that channel (${err.data ? err.data.error : err.message}). Make sure I've been invited to it.`,
        },
      });
      if (!alreadyNotified) {
        await client.chat.postMessage({
          channel: inviterId,
          text: `:warning: I couldn't read <#${sourceChannelId}>: ${err.data ? err.data.error : err.message}\nSetup docs: ${README_URL}`,
        });
      }
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View setup docs' },
            url: README_URL,
            action_id: 'view_readme',
          },
        ],
      });
    }
  }

  return blocks;
}

function readFormState(values) {
  return {
    sourceChannelId: values.source_block && values.source_block.source_select.selected_conversation,
    birthdayUserId: values.bday_block && values.bday_block.bday_select.selected_user,
    destChannelId: values.dest_block && values.dest_block.dest_select.selected_conversation,
    messageInput: values.message_block && values.message_block.message_input.value,
  };
}

async function refreshModal(body, client) {
  const inviterId = body.user.id;
  const { sourceChannelId, birthdayUserId, destChannelId, messageInput } = readFormState(
    body.view.state.values
  );

  const previewBlocks = await buildPreviewBlocks(client, {
    sourceChannelId,
    birthdayUserId,
    inviterId,
    messageInput,
  });

  await client.views.update({
    view_id: body.view.id,
    hash: body.view.hash,
    view: {
      type: 'modal',
      callback_id: 'bday_confirm',
      title: { type: 'plain_text', text: 'Birthday invite' },
      submit: { type: 'plain_text', text: 'Send invites' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        ...buildFormBlocks({ sourceChannelId, birthdayUserId, destChannelId, messageInput }),
        ...previewBlocks,
      ],
    },
  });
}

app.command('/bday', async ({ command, ack, client }) => {
  await ack();

  await client.views.open({
    trigger_id: command.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'bday_confirm',
      title: { type: 'plain_text', text: 'Birthday invite' },
      submit: { type: 'plain_text', text: 'Send invites' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: buildFormBlocks({}),
    },
  });
});

app.action('source_select', async ({ ack, body, client }) => {
  await ack();
  await refreshModal(body, client);
});

app.action('bday_select', async ({ ack, body, client }) => {
  await ack();
  await refreshModal(body, client);
});

app.action('connect_account', async ({ ack }) => {
  await ack();
});

app.action('view_readme', async ({ ack }) => {
  await ack();
});

app.view('bday_confirm', async ({ ack, view, client, body }) => {
  const inviterId = body.user.id;
  const { sourceChannelId, birthdayUserId, destChannelId, messageInput } = readFormState(
    view.state.values
  );

  if (destChannelId === sourceChannelId) {
    await ack({
      response_action: 'errors',
      errors: {
        dest_block: 'Pick a different channel than the one you\'re inviting from.',
      },
    });
    return;
  }

  await ack();

  let sourceChannelName;
  let members;
  try {
    const ctx = await fetchChannelContext(client, inviterId, sourceChannelId);
    sourceChannelName = ctx.info.channel.name;
    members = ctx.members;
  } catch (err) {
    if (err.needsConnect) {
      await client.chat.postMessage({
        channel: inviterId,
        text:
          `:lock: <#${sourceChannelId}> is a private channel I'm not in. Connect your Slack account, ` +
          `then run /bday again: ${CONNECT_URL}\nSetup docs: ${README_URL}`,
      });
    } else {
      await client.chat.postMessage({
        channel: inviterId,
        text: `I couldn't read <#${sourceChannelId}>: ${err.data ? err.data.error : err.message}\nSetup docs: ${README_URL}`,
      });
    }
    return;
  }

  const messageText = (messageInput || '').trim() || defaultMessage(birthdayUserId, inviterId);

  const botIds = await getBotUserIds(client, members);
  const toMessage = members.filter(
    (id) => id !== birthdayUserId && id !== inviterId && !botIds.has(id)
  );

  const buttonValue = JSON.stringify({
    dest: destChannelId,
    bday: birthdayUserId,
    inviter: inviterId,
  });

  let sent = 0;
  const failures = [];

  for (const userId of toMessage) {
    try {
      const im = await client.conversations.open({ users: userId });
      await client.chat.postMessage({
        channel: im.channel.id,
        text: messageText,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: messageText } },
          {
            type: 'actions',
            block_id: 'bday_response',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Accept' },
                style: 'primary',
                action_id: 'bday_accept',
                value: buttonValue,
              },
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Decline' },
                action_id: 'bday_decline',
                value: buttonValue,
              },
            ],
          },
        ],
      });
      sent += 1;
    } catch (err) {
      failures.push(userId);
    }
    // light rate-limit cushion between DMs
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const summaryLines = [
    `:yay: Successfully sent messages to ${sent} ${sent === 1 ? 'person' : 'people'} in <#${sourceChannelId}> (#${sourceChannelName}) for <@${birthdayUserId}>'s birthday.`,
  ];
  if (failures.length) {
    summaryLines.push(`Couldn't DM: ${failures.map((id) => `<@${id}>`).join(', ')}`);
  }

  await client.chat.postMessage({
    channel: inviterId,
    text: summaryLines.join('\n'),
  });
});

app.action('bday_accept', async ({ ack, body, client, action }) => {
  await ack();
  const { dest, bday, inviter } = JSON.parse(action.value);

  try {
    await client.conversations.invite({ channel: dest, users: body.user.id });
  } catch (err) {
    const code = err.data ? err.data.error : err.message;
    if (code !== 'already_in_channel') {
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: `I couldn't add you to the planning channel (${code}). Ask <@${inviter}> to invite me to it and try again.`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:warning: I couldn't add you to the planning channel (\`${code}\`). Ask <@${inviter}> to invite me to it and try again.`,
            },
          },
        ],
      });
      return;
    }
  }

  await client.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text: `You're in! I've added you to <#${dest}>.`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `:tada: You're in! I've added you to <#${dest}>. Shh, don't tell <@${bday}>!` },
      },
    ],
  });
});

app.action('bday_decline', async ({ ack, body, client }) => {
  await ack();
  await client.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text: 'No worries, maybe next time!',
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: 'No worries, maybe next time!' } },
    ],
  });
});

(async () => {
  await app.start();
  console.log('bday-bot is running (Socket Mode)');
})();
