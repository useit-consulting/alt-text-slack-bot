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

  // Check if this is a retry from Slack
  // According to Slack Events API docs, x-slack-retry-num header contains 1, 2, or 3 for retries
  // If present, this is a retry and we should acknowledge without processing to avoid duplicates
  const retryNum = event.headers['x-slack-retry-num'];
  if (retryNum) {
    const retryAttempt = parseInt(retryNum, 10);
    if (retryAttempt > 0) {
      console.log(`[Handler] Detected retry attempt #${retryAttempt} (x-slack-retry-num: ${retryNum}), acknowledging without processing to prevent duplicates`);
      return {
        statusCode: 200,
        headers: {
          'x-slack-no-retry': '1', // Tell Slack not to retry further
        },
        body: JSON.stringify({ ok: true }),
      };
    }
  }

  // Handle event callbacks
  if (body.type === 'event_callback') {
    const slackEvent = body.event;
    const eventId = body.event_id; // This is consistent across retries
    console.log('Event callback received, event type:', slackEvent.type, 'event_id:', eventId);

    // Process message events
    if (slackEvent.type === 'message') {
      console.log('Processing message event');
      
      // Check if message has files that need alt text
      if (slackEvent.files) {
        const imagesMissingAltText = getImageNamesWithMissingAltText(slackEvent.files);
        if (imagesMissingAltText.length > 0) {
          console.log(`[Handler] Found ${imagesMissingAltText.length} image(s) missing alt text, generating alt text`);
          
          // Wait for alt text generation to complete
          // This may take 5-10 seconds (download + API call), but ensures work completes
          // Slack will retry if we don't respond in 3 seconds, but we'll handle that gracefully with event_id deduplication
          const workStartTime = Date.now();
          try {
            await Promise.race([
              handleAltTextGeneration(slackEvent, SLACK_TOKEN, web, eventId),
              new Promise((_, reject) => setTimeout(() => {
                reject(new Error('Alt text generation timeout after 20 seconds'));
              }, 20000))
            ]);
            const workTime = Date.now() - workStartTime;
            console.log(`[Handler] Alt text generation completed in ${workTime}ms`);
          } catch (error) {
            const workTime = Date.now() - workStartTime;
            console.error(`[Handler] Alt text generation failed after ${workTime}ms:`, error);
            // Continue - we'll still return 200 to Slack
          }
        }
      }

      // Return to Slack
      // Note: This may be after 3 seconds, causing Slack to retry
      // But the function is idempotent using event_id, so retries are safe
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
