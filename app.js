require('dotenv').config();
const { App } = require('@slack/bolt');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
});

const CHANNEL_MENTION = /<#([CGD][A-Z0-9]+)(?:\|([^>]*))?>/;
const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/;

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

function defaultMessage(birthdayUserId) {
  return (
    `:tada: Shh... it's almost <@${birthdayUserId}>'s birthday! ` +
    `Want to help plan something special? Tap *Accept* below and I'll add you to the planning channel.`
  );
}

app.command('/bday', async ({ command, ack, client, respond }) => {
  await ack();

  const text = (command.text || '').trim();
  const [sub, ...rest] = text.split(/\s+/);

  if (sub !== 'invite') {
    await respond({
      response_type: 'ephemeral',
      text: 'Usage: `/bday invite #channel @birthday-person`',
    });
    return;
  }

  const restText = rest.join(' ');
  const channelMatch = restText.match(CHANNEL_MENTION);
  const userMatch = restText.match(USER_MENTION);

  if (!channelMatch || !userMatch) {
    await respond({
      response_type: 'ephemeral',
      text: 'Usage: `/bday invite #channel @birthday-person` — mention one channel and one person.',
    });
    return;
  }

  const sourceChannelId = channelMatch[1];
  const birthdayUserId = userMatch[1];

  let sourceChannelName = channelMatch[2];
  try {
    if (!sourceChannelName) {
      const info = await client.conversations.info({ channel: sourceChannelId });
      sourceChannelName = info.channel.name;
    }
  } catch (err) {
    await respond({
      response_type: 'ephemeral',
      text: `I couldn't look up that channel. Make sure I've been invited to it first. (${err.data ? err.data.error : err.message})`,
    });
    return;
  }

  const metadata = JSON.stringify({
    sourceChannelId,
    sourceChannelName,
    birthdayUserId,
    inviterId: command.user_id,
  });

  await client.views.open({
    trigger_id: command.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'bday_confirm',
      private_metadata: metadata,
      title: { type: 'plain_text', text: 'Birthday invite' },
      submit: { type: 'plain_text', text: 'Send invites' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `This will DM everyone in *#${sourceChannelName}* (except <@${birthdayUserId}>) ` +
              `the message below. Anyone who accepts gets added to the planning channel you pick.`,
          },
        },
        {
          type: 'input',
          block_id: 'message_block',
          label: { type: 'plain_text', text: 'Message to send' },
          element: {
            type: 'plain_text_input',
            action_id: 'value',
            multiline: true,
            initial_value: defaultMessage(birthdayUserId),
          },
        },
        {
          type: 'input',
          block_id: 'dest_block',
          label: { type: 'plain_text', text: 'Planning channel (the one you manage)' },
          element: {
            type: 'conversations_select',
            action_id: 'value',
            filter: { include: ['public', 'private'], exclude_bot_users: true },
          },
        },
      ],
    },
  });
});

app.view('bday_confirm', async ({ ack, view, client, body }) => {
  const { sourceChannelId, sourceChannelName, birthdayUserId, inviterId } = JSON.parse(
    view.private_metadata
  );

  const destChannelId = view.state.values.dest_block.value.selected_conversation;
  const messageText = view.state.values.message_block.value.value;

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

  let members;
  try {
    members = await getChannelMembers(client, sourceChannelId);
  } catch (err) {
    await client.chat.postMessage({
      channel: inviterId,
      text: `I couldn't read the member list for <#${sourceChannelId}>: ${err.data ? err.data.error : err.message}`,
    });
    return;
  }

  const toMessage = members.filter((id) => id !== birthdayUserId);

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
    `Sent birthday invites for <@${birthdayUserId}> to ${sent} ${sent === 1 ? 'person' : 'people'} in <#${sourceChannelId}> (#${sourceChannelName}).`,
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
