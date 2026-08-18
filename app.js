require('dotenv').config();
const http = require('http');
const crypto = require('crypto');
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
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // get a subdomain for ckacha and hook this up
const SLACK_OAUTH_REDIRECT_URI = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/slack/oauth/callback` : null;
const HACKCLUB_OAUTH_REDIRECT_URI = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/oauth/callback` : null;

const HACKCLUB_AUTH_BASE = 'https://auth.hackclub.com';
const HACKCLUB_SCOPE = 'openid profile';
const PENDING_CONNECTION_TTL_MS = 15 * 60 * 1000;

const CHAIN_ENABLED = Boolean(
  PUBLIC_BASE_URL &&
    process.env.SLACK_CLIENT_ID &&
    process.env.SLACK_CLIENT_SECRET &&
    process.env.HACKCLUB_CLIENT_ID &&
    process.env.HACKCLUB_CLIENT_SECRET
);

const ADMIN_SLACK_USER_ID = process.env.ADMIN_SLACK_USER_ID;

const README_URL = 'https://github.com/CKacha/bday-bot#readme';

const CONSENT_WARNING =
  ':warning: *Before you connect:* this grants access to the name, topic, and full member list ' +
  "of *every private channel/group you're in* — not just the one you're inviting from (Slack " +
  "doesn't allow scoping this to a single channel). It *cannot* post messages, read your DMs, or " +
  'change anything. The access token is stored on the server running this bot until you revoke it ' +
  '(Slack → your apps → Bday Bot → Remove), so treat it as a standing grant, not a one-time read.';

// state -> { slackUserId, hackclubVerified, createdAt }
const pendingConnections = new Map();

function buildConnectUrl(inviterId) {
  if (!CHAIN_ENABLED) return null;
  return `${PUBLIC_BASE_URL}/connect/start?slack_user=${encodeURIComponent(inviterId)}`;
}

function slackAuthorizeUrl(state) {
  return (
    `https://slack.com/oauth/v2/authorize?client_id=${process.env.SLACK_CLIENT_ID}` +
    `&user_scope=groups:read,channels:read` +
    `&redirect_uri=${encodeURIComponent(SLACK_OAUTH_REDIRECT_URI)}` +
    `&state=${encodeURIComponent(state)}`
  );
}

function hackclubAuthorizeUrl(state) {
  return (
    `${HACKCLUB_AUTH_BASE}/oauth/authorize?client_id=${process.env.HACKCLUB_CLIENT_ID}` +
    `&response_type=code&scope=${encodeURIComponent(HACKCLUB_SCOPE)}` +
    `&redirect_uri=${encodeURIComponent(HACKCLUB_OAUTH_REDIRECT_URI)}` +
    `&state=${encodeURIComponent(state)}`
  );
}

function getPendingConnection(state) {
  const pending = pendingConnections.get(state);
  if (!pending) return null;
  if (Date.now() - pending.createdAt > PENDING_CONNECTION_TTL_MS) {
    pendingConnections.delete(state);
    return null;
  }
  return pending;
}

function getUserClient(userId) {
  // SLACK_USER_TOKEN rn is only for testing
  // get rid of this part in roduction since token storing is gonna be differnet
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
    if (!userClient && CHAIN_ENABLED && missingAccess) {
      const needsConnectErr = new Error('needs_connect');
      needsConnectErr.needsConnect = true;
      throw needsConnectErr;
    }
    throw err;
  }
}

function sendHtml(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html' });
  res.end(`<html><body>${body}</body></html>`);
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${OAUTH_PORT}`);

    // connection to hc auth
    if (url.pathname === '/connect/start') {
      const slackUserId = url.searchParams.get('slack_user');
      if (!slackUserId) {
        sendHtml(res, 400, 'Missing slack_user.');
        return;
      }
      const state = crypto.randomUUID();
      pendingConnections.set(state, { slackUserId, hackclubVerified: false, createdAt: Date.now() });
      res.writeHead(302, { Location: hackclubAuthorizeUrl(state) });
      res.end();
      return;
    }

    // hc oauth
    if (url.pathname === '/oauth/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const pending = state && getPendingConnection(state);
      if (!code || !pending) {
        sendHtml(res, 400, 'This connection link expired or is invalid. Start over from the /bdaypheus modal.');
        return;
      }

      try {
        const tokenResp = await fetch(`${HACKCLUB_AUTH_BASE}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: process.env.HACKCLUB_CLIENT_ID,
            client_secret: process.env.HACKCLUB_CLIENT_SECRET,
            redirect_uri: HACKCLUB_OAUTH_REDIRECT_URI,
            code,
            grant_type: 'authorization_code',
          }),
        });
        const tokenData = await tokenResp.json();
        if (!tokenResp.ok || !tokenData.access_token) {
          sendHtml(res, 400, "Hack Club Auth didn't confirm your identity. Please try again.");
          return;
        }

        pending.hackclubVerified = true;
        res.writeHead(302, { Location: slackAuthorizeUrl(state) });
        res.end();
      } catch (err) {
        sendHtml(res, 500, 'Something went wrong verifying your Hack Club account.');
      }
      return;
    }

    // should callback to slack if it works
    if (url.pathname === '/slack/oauth/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const pending = state && getPendingConnection(state);

      if (!code) {
        sendHtml(res, 400, 'Missing code.');
        return;
      }
      if (CHAIN_ENABLED && (!pending || !pending.hackclubVerified)) {
        sendHtml(res, 400, 'Hack Club verification is required first. Start over from the /bdaypheus modal.');
        return;
      }

      try {
        const result = await new WebClient().oauth.v2.access({
          client_id: process.env.SLACK_CLIENT_ID,
          client_secret: process.env.SLACK_CLIENT_SECRET,
          code,
          redirect_uri: SLACK_OAUTH_REDIRECT_URI,
        });
        const userId = result.authed_user && result.authed_user.id;
        const userToken = result.authed_user && result.authed_user.access_token;
        if (!userId || !userToken) {
          sendHtml(res, 400, "Slack didn't return a user token. Make sure the app requests user scopes.");
          return;
        }
        tokenStore.set(userId, userToken);
        if (state) pendingConnections.delete(state);
        sendHtml(res, 200, 'Connected! You can close this tab and go back to Slack.');
      } catch (err) {
        sendHtml(res, 500, 'Something went wrong connecting your account.');
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');

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

const MAX_USERGROUP_SUGGESTIONS = 100; // figure out group preloading
const USERGROUP_CACHE_TTL_MS = 60 * 1000;
let usergroupCache = { data: [], fetchedAt: 0 };

async function getUsergroups(client) {
  if (Date.now() - usergroupCache.fetchedAt < USERGROUP_CACHE_TTL_MS) {
    return usergroupCache.data;
  }
  const resp = await client.usergroups.list();
  usergroupCache = { data: resp.usergroups || [], fetchedAt: Date.now() };
  return usergroupCache.data;
}

function toUsergroupOption(g) {
  return {
    text: { type: 'plain_text', text: `@${g.handle || g.name}` },
    value: g.id,
  };
}

async function getUsergroupOptions(client) {
  try {
    const groups = await getUsergroups(client);
    return groups.map(toUsergroupOption);
  } catch (err) {
    // should only happen with usergroups:read scope missing/failed
    return [];
  }
}

async function getUsergroupMembers(client, groupId) {
  const resp = await client.usergroups.users.list({ usergroup: groupId });
  return resp.users || [];
}

function defaultMessage(birthdayUserId, inviterId) {
  return (
    `:tada: <@${inviterId}> sent you an invite for <@${birthdayUserId}>'s birthday! ` +
    `Want to help plan something special? Tap *Accept* below and I'll add you to the planning channel.`
  );
}

const MAX_PREVIEW_LISTED = 40;

function buildFormBlocks({
  sourceChannelId,
  birthdayUserId,
  destChannelId,
  groupId,
  messageInput,
  usergroupOptions = [],
}) {
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

    ...(usergroupOptions.length
      ? [
          {
            type: 'input',
            block_id: 'group_block',
            label: { type: 'plain_text', text: 'Also invite this group (optional)' },
            optional: true,
            dispatch_action: true,
            element: {
              type: 'external_select',
              action_id: 'group_select',
              placeholder: { type: 'plain_text', text: 'Type to search groups…' },
              min_query_length: 0,
              ...(groupId
                ? { initial_option: usergroupOptions.find((o) => o.value === groupId) }
                : {}),
            },
          },
        ]
      : []),

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

async function buildPreviewBlocks(
  client,
  { sourceChannelId, birthdayUserId, inviterId, groupId, messageInput }
) {
  if (!sourceChannelId) return [];

  const blocks = [{ type: 'divider' }];

  try {
    const { info, members } = await fetchChannelContext(client, inviterId, sourceChannelId);
    const sourceChannelName = info.channel.name;

    const allMembers = new Set(members);
    let groupMemberCount = 0;
    if (groupId) {
      try {
        const groupMembers = await getUsergroupMembers(client, groupId);
        groupMemberCount = groupMembers.length;
        groupMembers.forEach((id) => allMembers.add(id));
      } catch (err) {
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:warning: Couldn't load that group's members (${err.data ? err.data.error : err.message}).`,
          },
        });
      }
    }

    const botIds = await getBotUserIds(client, [...allMembers]);
    const recipients = [...allMembers].filter(
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
      : '_Nobody else to invite._';
    const sourceLabel = groupId
      ? `#${sourceChannelName} + the group (${groupMemberCount} members)`
      : `#${sourceChannelName}`;

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*The following ${recipients.length} ${recipients.length === 1 ? 'person' : 'people'} will be added (from ${sourceLabel}):*\n${listText}`,
      },
    });
  } catch (err) {
    const dmKey = `${inviterId}:${sourceChannelId}:${err.needsConnect ? 'connect' : 'error'}`;
    const alreadyNotified = notifiedAccessFailures.has(dmKey);
    notifiedAccessFailures.add(dmKey);

    if (err.needsConnect) {
      const connectUrl = buildConnectUrl(inviterId);

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            ":lock: That's a private channel I'm not in. I've sent you a DM with how to connect your " +
            "Slack account — reselect the channel here afterward to refresh this preview, or hit " +
            "Cancel above to close this.",
        },
      });

      if (!alreadyNotified) {
        await client.chat.postMessage({
          channel: inviterId,
          text: `:lock: <#${sourceChannelId}> is a private channel I'm not in. Connect your Slack account to let me read it.`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text:
                  `:lock: <#${sourceChannelId}> is a private channel I'm not in. Connect your Slack account ` +
                  "(you'll verify with Hack Club Auth first), then reselect the channel in the /bdaypheus modal.",
              },
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: CONSENT_WARNING },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Connect your Slack account' },
                  url: connectUrl,
                  action_id: 'connect_account',
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'View setup docs' },
                  url: README_URL,
                  action_id: 'view_readme',
                },
              ],
            },
          ],
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
  const groupSelect = values.group_block && values.group_block.group_select;
  return {
    sourceChannelId: values.source_block && values.source_block.source_select.selected_conversation,
    birthdayUserId: values.bday_block && values.bday_block.bday_select.selected_user,
    destChannelId: values.dest_block && values.dest_block.dest_select.selected_conversation,
    groupId: groupSelect && groupSelect.selected_option && groupSelect.selected_option.value,
    messageInput: values.message_block && values.message_block.message_input.value,
  };
}

async function refreshModal(body, client) {
  const inviterId = body.user.id;
  const { sourceChannelId, birthdayUserId, destChannelId, groupId, messageInput } = readFormState(
    body.view.state.values
  );

  const [usergroupOptions, previewBlocks] = await Promise.all([
    getUsergroupOptions(client),
    buildPreviewBlocks(client, { sourceChannelId, birthdayUserId, inviterId, groupId, messageInput }),
  ]);

  await client.views.update({
    view_id: body.view.id,
    view: {
      type: 'modal',
      callback_id: 'bday_confirm',
      title: { type: 'plain_text', text: 'Birthday invite' },
      submit: { type: 'plain_text', text: 'Send invites' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        ...buildFormBlocks({ sourceChannelId, birthdayUserId, destChannelId, groupId, messageInput, usergroupOptions }),
        ...previewBlocks,
      ],
    },
  });
}

app.command('/bdaypheus', async ({ command, ack, client }) => {
  await ack();

  const usergroupOptions = await getUsergroupOptions(client);

  await client.views.open({
    trigger_id: command.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'bday_confirm',
      title: { type: 'plain_text', text: 'Birthday invite' },
      submit: { type: 'plain_text', text: 'Send invites' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: buildFormBlocks({ usergroupOptions }),
    },
  });
});

app.command('/link-bdaypheus', async ({ command, ack, respond }) => {
  await ack();

  if (!CHAIN_ENABLED) {
    await respond({
      response_type: 'ephemeral',
      text: 'The account-connect flow isn\'t configured yet (missing PUBLIC_BASE_URL/client credentials).',
    });
    return;
  }

  if (tokenStore.get(command.user_id)) {
    await respond({
      response_type: 'ephemeral',
      text: "You're already connected — no need to do this again! I'll use that connection automatically next time I need to read a private channel you're in.",
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              ":white_check_mark: You're already connected — no need to do this again! I'll use it " +
              "automatically the next time I need to read a private channel you're in.",
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: 'If Slack access was revoked or something seems off, use the button below to reconnect.',
            },
          ],
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Reconnect anyway' },
              url: buildConnectUrl(command.user_id),
              action_id: 'connect_account',
            },
          ],
        },
      ],
    });
    return;
  }

  await respond({
    response_type: 'ephemeral',
    text: 'Connect your Slack account (verifies with Hack Club Auth first) so I can read private channels you\'re in:',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            'Connect your Slack account so I can read private channels you\'re in — ' +
            "you'll verify with Hack Club Auth first, then grant Slack access.",
        },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: CONSENT_WARNING },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Connect your Slack account' },
            url: buildConnectUrl(command.user_id),
            action_id: 'connect_account',
          },
        ],
      },
    ],
  });
});

app.command('/remove-bdaypheus', async ({ command, ack, client, respond }) => {
  await ack();

  if (!ADMIN_SLACK_USER_ID) {
    await respond({
      response_type: 'ephemeral',
      text: "Token removal isn't configured yet (missing ADMIN_SLACK_USER_ID).",
    });
    return;
  }

  if (!tokenStore.get(command.user_id)) {
    await respond({
      response_type: 'ephemeral',
      text: "You don't have a connected Slack account to remove.",
    });
    return;
  }

  await client.chat.postMessage({
    channel: ADMIN_SLACK_USER_ID,
    text: `<@${command.user_id}> is requesting to remove their connected Slack account (token).`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:key: <@${command.user_id}> is requesting to remove their connected Slack account (token).`,
        },
      },
      {
        type: 'actions',
        block_id: 'remove_token_decision',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Approve' },
            style: 'primary',
            action_id: 'remove_token_approve',
            value: JSON.stringify({ requesterId: command.user_id }),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Reject' },
            style: 'danger',
            action_id: 'remove_token_reject',
            value: JSON.stringify({ requesterId: command.user_id }),
          },
        ],
      },
    ],
  });

  await respond({
    response_type: 'ephemeral',
    text: "Your removal request has been sent for approval. You'll get a DM once it's decided.",
  });
});

app.action('remove_token_approve', async ({ ack, body, client, action }) => {
  await ack();
  if (body.user.id !== ADMIN_SLACK_USER_ID) return;

  const { requesterId } = JSON.parse(action.value);
  tokenStore.remove(requesterId);

  await client.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text: `:white_check_mark: Approved — removed <@${requesterId}>'s token.`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `:white_check_mark: Approved — removed <@${requesterId}>'s token.` },
      },
    ],
  });

  await client.chat.postMessage({
    channel: requesterId,
    text: ':white_check_mark: Your connected Slack account (token) was removed, as requested.',
  });
});

app.action('remove_token_reject', async ({ ack, body, client, action }) => {
  await ack();
  if (body.user.id !== ADMIN_SLACK_USER_ID) return;

  const { requesterId } = JSON.parse(action.value);

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'remove_reject_modal',
      private_metadata: JSON.stringify({
        requesterId,
        channel: body.channel.id,
        ts: body.message.ts,
      }),
      title: { type: 'plain_text', text: 'Reject removal' },
      submit: { type: 'plain_text', text: 'Send' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'reason_block',
          label: { type: 'plain_text', text: `Reason for rejecting <@${requesterId}>'s request` },
          element: {
            type: 'plain_text_input',
            action_id: 'reason_input',
            multiline: true,
          },
        },
      ],
    },
  });
});

app.view('remove_reject_modal', async ({ ack, view, client }) => {
  await ack();

  const { requesterId, channel, ts } = JSON.parse(view.private_metadata);
  const reason = view.state.values.reason_block.reason_input.value;

  await client.chat.update({
    channel,
    ts,
    text: `:no_entry: Rejected <@${requesterId}>'s removal request.`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:no_entry: Rejected <@${requesterId}>'s removal request.\n*Reason:* ${reason}`,
        },
      },
    ],
  });

  await client.chat.postMessage({
    channel: requesterId,
    text: `Your request to remove your connected Slack account was rejected.\n*Reason:* ${reason}`,
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

app.action('group_select', async ({ ack, body, client }) => {
  await ack();
  await refreshModal(body, client);
});

app.options('group_select', async ({ ack, payload, client }) => {
  const query = (payload.value || '').toLowerCase();
  let groups = [];
  try {
    groups = await getUsergroups(client);
  } catch (err) {
    await ack({ options: [] });
    return;
  }

  const options = groups
    .filter((g) => {
      const handle = (g.handle || '').toLowerCase();
      const name = (g.name || '').toLowerCase();
      return !query || handle.includes(query) || name.includes(query);
    })
    .slice(0, MAX_USERGROUP_SUGGESTIONS)
    .map(toUsergroupOption);

  await ack({ options });
});


app.action('connect_account', async ({ ack }) => {
  await ack();
});

app.action('view_readme', async ({ ack }) => {
  await ack();
});

app.view('bday_confirm', async ({ ack, view, client, body }) => {
  const inviterId = body.user.id;
  const { sourceChannelId, birthdayUserId, destChannelId, groupId, messageInput } = readFormState(
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
          `:lock: <#${sourceChannelId}> is a private channel I'm not in. Connect your Slack account ` +
          `(you'll verify with Hack Club Auth first), then run /bdaypheus again: ${buildConnectUrl(inviterId)}\n\n` +
          `${CONSENT_WARNING}\n\nSetup docs: ${README_URL}`,
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

  const allMembers = new Set(members);
  if (groupId) {
    try {
      const groupMembers = await getUsergroupMembers(client, groupId);
      groupMembers.forEach((id) => allMembers.add(id));
    } catch (err) {
      await client.chat.postMessage({
        channel: inviterId,
        text: `:warning: Couldn't load that group's members, so it was skipped (${err.data ? err.data.error : err.message}).`,
      });
    }
  }

  const botIds = await getBotUserIds(client, [...allMembers]);
  const toMessage = [...allMembers].filter(
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
    // rate limit evventually test if the timeout happens
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
