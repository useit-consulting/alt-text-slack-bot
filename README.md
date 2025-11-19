# alt-text-slack-bot

`alt-text-slack-bot` aims to encourage accessible image sharing in a Slack workspace. When configured and added to a workspace, this Slack bot will detect when an image file has been shared in a channel without alternative text. It will send a friendly reminder that can only be seen by the user who posted the image along with instructions on how to add the alternative text. Optionally, the bot can also generate AI-powered alt text suggestions to make it even easier for users to add accessible descriptions.

<img width="500" alt="Screenshot of a message on Slack from a bot that says `Uh oh! The image you shared is missing alt text` along with how to add alt text, in response to an image I sent. The bot message has a note, `Only visible to you`." src="https://user-images.githubusercontent.com/16447748/167228612-b0caa58e-6741-4f93-acd5-51b73a0cfbb7.png">


This repo contains the code for the bot setup and should be customized to fit your workspace needs. For a comprehensive guide on the process of setting up a Slack app and installing it in a workspace, check out a fantastic tutorial by `@lukeocodes` at [DEV: Guy's Bot - Inclusive Language in Slack](https://dev.to/lukeocodes/who-s-a-good-bot-a-slack-bot-for-inclusive-language-2fkh).

## Motivation

The alt text feature in Slack is relatively new and hidden so a lot of people don't know about it or forget to use it. This bot was created to ensure that images are accessible to everyone, including channel members who are blind or have low-vision. This bot eliminates the potential burden of individual members having to remind people to add alt text.

## Deployment to Netlify

This bot is configured to deploy as a serverless function on Netlify. Follow these steps to set up and deploy:

### Prerequisites

- A Netlify account (paid org account recommended for better performance)
- A Slack workspace where you have permission to install apps
- Node.js and npm installed locally (for testing)

### Step 1: Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**
2. Choose **From scratch**
3. Give your app a name (e.g., "Alt Text Reminder Bot") and select your workspace
4. Click **Create App**

### Step 2: Configure Slack App Permissions

1. In the left sidebar, go to **OAuth & Permissions**
2. Scroll down to **Scopes** → **Bot Token Scopes**
3. Add the following scope:
   - `chat:write` - Allows the bot to send messages
4. Scroll up and click **Install to Workspace**
5. Authorize the app in your workspace
6. **Copy the Bot User OAuth Token** (starts with `xoxb-`) - you'll need this for Netlify
   - ⚠️ **Note**: This is the "Bot User OAuth Token", NOT the "Client Secret". The Client Secret is a different credential used for OAuth installations and is not needed for this bot.

### Step 3: Enable Events API

1. In the left sidebar, go to **Event Subscriptions**
2. Toggle **Enable Events** to **On**
3. You'll need to set the Request URL later (after deploying to Netlify)
4. Under **Subscribe to bot events**, click **Add Bot User Event**
5. Add the event: `message.channels` - This allows the bot to receive messages posted to channels
6. Click **Save Changes**

### Step 4: Get Your Signing Secret

1. In the left sidebar, go to **Basic Information**
2. Under **App Credentials**, find **Signing Secret**
3. Click **Show** and copy the value - you'll need this for Netlify

### Step 5: Deploy to Netlify

#### Option A: Deploy via Netlify Dashboard (Recommended)

1. Push your code to a Git repository (GitHub, GitLab, or Bitbucket)
2. Go to [app.netlify.com](https://app.netlify.com) and sign in
3. Click **Add new site** → **Import an existing project**
4. Connect your Git provider and select this repository
5. Configure build settings:
   - **Build command**: `npm run dist`
   - **Publish directory**: (leave empty - not needed for functions)
6. Click **Show advanced** and add environment variables:
   - `SLACK_TOKEN` - Your Bot User OAuth Token (from Step 2)
   - `SLACK_SIGNING_SECRET` - Your Signing Secret (from Step 4)
   - `ALT_TEXT_GENERATION_API_KEY` - API key for the alt text generation service (optional, but required for suggestions)
7. Click **Deploy site**

#### Option B: Deploy via Netlify CLI

1. Install Netlify CLI: `npm install -g netlify-cli`
2. Login: `netlify login`
3. Initialize: `netlify init`
4. Set environment variables:
   ```bash
   netlify env:set SLACK_TOKEN "xoxb-your-token-here"
   netlify env:set SLACK_SIGNING_SECRET "your-signing-secret-here"
   netlify env:set ALT_TEXT_GENERATION_API_KEY "your-api-key-here"
   ```
5. Deploy: `netlify deploy --prod`

### Step 6: Configure Slack Events URL

1. After deployment, go to your Netlify site dashboard
2. Navigate to **Functions** in the left sidebar
3. Find `slack-events` and copy its URL (it will look like: `https://your-site.netlify.app/.netlify/functions/slack-events`)
4. Go back to your Slack app settings → **Event Subscriptions**
5. Paste the URL into **Request URL**
6. Slack will verify the URL (you should see a checkmark)
7. If verification fails, ensure:
   - The function deployed successfully
   - Environment variables are set correctly
   - The URL is accessible (not behind authentication)

### Step 7: Invite Bot to Channels

The bot needs to be invited to channels where you want it to monitor images:

1. In Slack, go to any channel where you want the bot active
2. Type `/invite @YourBotName` or use the channel settings to add the bot
3. The bot will now monitor that channel for images without alt text

## Local Development

To test the bot locally before deploying:

1. Install dependencies: `npm install`
2. Build the project: `npm run dist`
3. Set environment variables:
   ```bash
   export SLACK_TOKEN="xoxb-your-token-here"
   export SLACK_SIGNING_SECRET="your-signing-secret-here"
   export ALT_TEXT_GENERATION_API_KEY="your-api-key-here"
   ```
4. Use a tool like [ngrok](https://ngrok.com/) to expose your local server:
   ```bash
   ngrok http 3000
   ```
5. Use the ngrok URL as your Slack Events Request URL for testing

## Requirements

### Slack permissions

- [messages:channels](https://api.slack.com/events/message.channels): allows subscription to receive events of messages that are posted to the channel.
- [chat:write](https://api.slack.com/scopes/chat:write): send messages as your configured Slack bot.

### Environment variables

The following environment variables must be set in Netlify:

- `SLACK_TOKEN`: Bot User OAuth Token from the **OAuth and Permissions** tab (starts with `xoxb-`).
  - ⚠️ **Not the Client Secret** - Make sure you're copying the "Bot User OAuth Token", not the "Client Secret"
- `SLACK_SIGNING_SECRET`: Signing secret from the **Basic Information** tab (under App Credentials).
- `ALT_TEXT_GENERATION_API_KEY`: API key for the alt text generation service (optional).
  - If not set, the bot will still send reminders but won't generate alt text suggestions.
  - The bot will gracefully handle API failures and still send reminders without suggestions.

## Tips

- If you prefer not to experiment with a Slack app in an active workspace, you can create a free test workspace.
- Customize the bot message by updating `src/utils.ts`.
- The bot sends ephemeral messages (only visible to the user who posted the image) to avoid cluttering channels.
- The bot automatically handles threaded messages and will respond in the same thread.
- Alt text suggestions are generated in Swedish and are formatted as copyable code blocks in the message.
- If the alt text generation API fails or the API key is not set, the bot will still send reminders without suggestions.
