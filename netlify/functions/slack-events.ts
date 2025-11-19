import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { createHmac } from 'crypto';
import { WebClient, ChatPostEphemeralArguments } from '@slack/web-api';
import { generateResponseText, getImageNamesWithMissingAltText } from '../../src/utils';

const SLACK_TOKEN = process.env.SLACK_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

if (!SLACK_TOKEN || !SLACK_SIGNING_SECRET) {
  throw new Error('SLACK_TOKEN and SLACK_SIGNING_SECRET must be set');
}

const web = new WebClient(SLACK_TOKEN);

/**
 * Verify the request signature from Slack
 */
function verifySlackRequest(
  timestamp: string,
  body: string,
  signature: string
): boolean {
  const hmac = createHmac('sha256', SLACK_SIGNING_SECRET);
  const [version, hash] = signature.split('=');
  const baseString = `${version}:${timestamp}:${body}`;
  hmac.update(baseString);
  const expectedHash = hmac.digest('hex');
  return hash === expectedHash;
}

/**
 * Handle URL verification challenge from Slack
 */
function handleUrlVerification(body: any): { statusCode: number; body: string } {
  return {
    statusCode: 200,
    body: JSON.stringify({ challenge: body.challenge }),
  };
}

/**
 * Process message events and send ephemeral reminders for missing alt text
 */
async function handleMessageEvent(event: any): Promise<void> {
  console.log('Received message event:', JSON.stringify(event, null, 2));
  
  // Ignore bot messages and messages without files
  if (event.subtype === 'bot_message') {
    console.log('Ignoring bot message');
    return;
  }
  
  if (!event.files) {
    console.log('Message has no files property');
    return;
  }
  
  console.log('Files in event:', JSON.stringify(event.files, null, 2));
  
  const filesnamesMissingAltText: string[] = getImageNamesWithMissingAltText(
    event.files
  );
  
  console.log('Images missing alt text:', filesnamesMissingAltText);

  if (filesnamesMissingAltText.length > 0) {
    const parameters: ChatPostEphemeralArguments = {
      channel: event.channel,
      user: event.user,
      text: generateResponseText(event.files.length, filesnamesMissingAltText),
    };

    if (event.thread_ts) {
      parameters.thread_ts = event.thread_ts;
    }

    try {
      console.log('Sending ephemeral message with parameters:', JSON.stringify(parameters, null, 2));
      await web.chat.postEphemeral(parameters);
      console.log('Ephemeral message sent successfully');
    } catch (error) {
      console.error('Error sending ephemeral message:', error);
    }
  } else {
    console.log('No images missing alt text, not sending message');
  }
}

/**
 * Netlify serverless function handler
 */
export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext
) => {
  // Verify request signature
  const timestamp = event.headers['x-slack-request-timestamp'] || '';
  const signature = event.headers['x-slack-signature'] || '';

  // Prevent replay attacks (requests older than 5 minutes)
  const currentTime = Math.floor(Date.now() / 1000);
  const requestTime = parseInt(timestamp, 10);
  if (Math.abs(currentTime - requestTime) > 300) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Request timestamp too old' }),
    };
  }

  if (!verifySlackRequest(timestamp, event.body || '', signature)) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Invalid signature' }),
    };
  }

  // Parse request body
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (error) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid JSON' }),
    };
  }

  // Handle URL verification challenge
  if (body.type === 'url_verification') {
    return handleUrlVerification(body);
  }

  // Handle event callbacks
  if (body.type === 'event_callback') {
    const slackEvent = body.event;
    console.log('Event callback received, event type:', slackEvent.type);

    // Process message events asynchronously
    if (slackEvent.type === 'message') {
      console.log('Processing message event');
      // Don't await - respond immediately to Slack
      handleMessageEvent(slackEvent).catch((error) => {
        console.error('Error processing message event:', error);
      });

      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true }),
      };
    }
  }

  // Return 200 for other event types to acknowledge receipt
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true }),
  };
};
