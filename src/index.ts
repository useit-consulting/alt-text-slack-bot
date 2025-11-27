import {ChatPostEphemeralArguments} from '@slack/web-api'
import {generateResponseText, getImageNamesWithMissingAltText} from "./utils";

const SLACK_TOKEN = process.env.SLACK_TOKEN
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET

const { createEventAdapter } = require('@slack/events-api')
const { WebClient } = require('@slack/web-api')

const web = new WebClient(SLACK_TOKEN)
const slackEvents = createEventAdapter(SLACK_SIGNING_SECRET)
const port = process.env.PORT || 3000;

/**
 * Get list of excluded user IDs from environment variable
 */
function getExcludedUserIds(): string[] {
  const excludedUsers = process.env.EXCLUDED_USER_IDS;
  if (!excludedUsers) {
    return [];
  }
  return excludedUsers.split(',').map(id => id.trim()).filter(id => id.length > 0);
}

slackEvents.on('message', (event) => {
  // Check if user is excluded from reminders
  const excludedUserIds = getExcludedUserIds();
  if (event.user && excludedUserIds.includes(event.user)) {
    console.log(`[Message Handler] User ${event.user} is excluded from alt text reminders`);
    return;
  }

  if (event.hasOwnProperty('files')) {
    const filesnamesMissingAltText: string[] = getImageNamesWithMissingAltText(event.files)
    if (filesnamesMissingAltText.length > 0) {
      const workspaceType = process.env.SLACK_WORKSPACE === 't12t' ? 't12t' : 'useit';
      const parameters: ChatPostEphemeralArguments = {
        channel: event.channel,
        user: event.user,
        text: generateResponseText(event.files.length, filesnamesMissingAltText, undefined, workspaceType)
      }
      if (event.hasOwnProperty('thread_ts')) {
        parameters.thread_ts = event.thread_ts
      }
      web.chat.postEphemeral(parameters)
    }
  }
})

slackEvents.on('error', console.error)

slackEvents.start(port).then(() => {
  console.log(`server listening on port ${port}`)
})
