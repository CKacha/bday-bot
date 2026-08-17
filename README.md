# bday-bot
Slack bot to invite people to birthday card channels!

Uhh people annoyed about being added to many bday card channels and here is my solution

## How to set up:

Go to https://api.slack.com/apps to get the relevant .env variables (look at .env.example for the specific ones!)

Make sure your bot has the following bot permissions enabled in the config:

- commands
- chat:write
- im:write
- channels:read
- groups:read
- channels:manage
- groups:write
- users:read

Also turn on Socket Mode & Interactivity & Shortcuts

## Inviting from a private channel (without adding the bot to it)

If you invite from a private channel the bot isn't a member of, the modal will show a
"Connect your Slack account" button instead of a preview. Clicking it authorizes the app
to read channels *you're* a member of, using your own permissions — the bot itself never
joins the channel, so nothing shows up in its member list.

To turn this on:

1. On your app's **Basic Information** page, grab the **Client ID** and **Client Secret**.
2. Under **OAuth & Permissions**, add `groups:read` and `channels:read` as **User Token Scopes**,
   and add a **Redirect URL** pointing at `<your-public-url>/slack/oauth/callback`.
3. Expose this bot's OAuth server (default port `3000`) to the internet — for local testing,
   `ngrok http 3000` works well. Copy the `https://...ngrok...` URL it gives you.
4. Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_REDIRECT_URI` in `.env`
   (`SLACK_REDIRECT_URI` = the ngrok URL + `/slack/oauth/callback`, matching step 2 exactly).

Each person only has to connect once — their token is stored locally in `tokens.json`
(gitignored, never committed). Note: since ngrok's free tier gives you a new URL every
restart, you'll need to update the redirect URL in both Slack's config and `.env` each
time you restart the tunnel, until this is deployed somewhere with a stable URL.
