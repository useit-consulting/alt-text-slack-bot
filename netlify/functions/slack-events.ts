import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { createHmac } from 'crypto';
import { WebClient } from '@slack/web-api';
import { getImageNamesWithMissingAltText, handleAltTextGeneration } from '../../src/utils';

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

    // Process message events
    if (slackEvent.type === 'message') {
      console.log('Processing message event');
      
      // Check if message has files that need alt text
      if (slackEvent.files) {
        const imagesMissingAltText = getImageNamesWithMissingAltText(slackEvent.files);
        if (imagesMissingAltText.length > 0) {
          console.log(`[Handler] Found ${imagesMissingAltText.length} image(s) missing alt text, starting background generation`);
          
          // Start the work
          const workPromise = handleAltTextGeneration(slackEvent, SLACK_TOKEN, web);
          
          // Wait up to 1.5 seconds for download to start/complete
          // This keeps the context alive long enough for the download (thumbnails are fast)
          // Then return to Slack - API call will continue if context stays alive
          await Promise.race([
            workPromise.then(() => {
              console.log('[Handler] Work completed before timeout');
            }),
            new Promise((resolve) => setTimeout(() => {
              console.log('[Handler] Returning to Slack after 1.5s - work continues in background');
              resolve(null);
            }, 1500))
          ]);
        }
      }

      // Return to Slack (within 3 second requirement)
      // Work may continue in background if context stays alive
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
