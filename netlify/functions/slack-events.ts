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
 * Trigger alt text generation in the background
 * Executes directly without HTTP call - avoids network timeout issues
 */
function triggerAltTextGeneration(event: any): void {
  console.log(`[Handler] Starting background alt text generation`);
  console.log(`[Handler] Event data:`, JSON.stringify({ 
    eventType: event.type, 
    hasFiles: !!event.files,
    fileCount: event.files?.length || 0 
  }));

  // Execute in background - don't await, just fire and forget
  // This runs after we return to Slack, keeping the execution context alive
  handleAltTextGeneration(event, SLACK_TOKEN, web).catch((error) => {
    console.error('[Handler] Background alt text generation error:', error);
  });
  
  console.log('[Handler] Background alt text generation initiated');
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
          // Trigger alt text generation - fire and forget, runs after we return
          triggerAltTextGeneration(slackEvent);
        }
      }

      // Return immediately to Slack (within 3 second requirement)
      // Background function will handle the alt text generation and message sending
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
