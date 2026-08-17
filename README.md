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
