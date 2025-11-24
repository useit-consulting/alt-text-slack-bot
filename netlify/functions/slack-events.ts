import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { createHmac } from 'crypto';
import { getImageNamesWithMissingAltText } from '../../src/utils';

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const NETLIFY_SITE_URL = process.env.URL || process.env.DEPLOY_PRIME_URL || '';

if (!SLACK_SIGNING_SECRET) {
  throw new Error('SLACK_SIGNING_SECRET must be set');
}

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
          
          // Invoke background function asynchronously (fire and forget)
          // This allows us to respond to Slack immediately while the background function
          // processes the alt text generation (which can take 5-10 seconds)
          
          // Construct the background function URL
          // Try to get it from environment variables, or construct from request
          let backgroundFunctionUrl: string;
          if (NETLIFY_SITE_URL) {
            backgroundFunctionUrl = `${NETLIFY_SITE_URL}/.netlify/functions/slack-events-background`;
          } else if (event.headers.host) {
            // Construct from the incoming request
            const protocol = event.headers['x-forwarded-proto'] || 'https';
            backgroundFunctionUrl = `${protocol}://${event.headers.host}/.netlify/functions/slack-events-background`;
          } else {
            console.error('[Handler] Cannot determine site URL for background function invocation');
            console.error('[Handler] Set URL or DEPLOY_PRIME_URL environment variable, or ensure Host header is present');
            // Still return 200 to Slack - we don't want to cause retries
            return {
              statusCode: 200,
              body: JSON.stringify({ ok: true }),
            };
          }
          
          console.log(`[Handler] Invoking background function: ${backgroundFunctionUrl}`);
          console.log(`[Handler] Passing slackEvent with ${slackEvent.files?.length || 0} file(s)`);
          
          // Verify we have the necessary data
          if (!slackEvent.files || slackEvent.files.length === 0) {
            console.warn('[Handler] Warning: slackEvent.files is missing or empty');
          } else {
            // Log file details to verify URLs are present
            slackEvent.files.forEach((file: any, index: number) => {
              const hasUrl = file.thumb_800 || file.thumb_720 || file.thumb_480 || file.thumb_360 || file.url_private || file.url_private_download;
              console.log(`[Handler] File ${index + 1}: ${file.name}, has URL: ${!!hasUrl}`);
            });
          }
          
          // Fire and forget - don't await to ensure we respond to Slack quickly
          // The background function will run asynchronously for up to 15 minutes
          // The slackEvent object contains all file metadata including URLs (thumb_*, url_private, etc.)
          // These URLs are persistent and can be accessed with the SLACK_TOKEN in the background function
          fetch(backgroundFunctionUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              slackEvent,
              eventId,
            }),
          }).catch((error) => {
            console.error(`[Handler] Failed to invoke background function:`, error);
            // Non-fatal - we've already responded to Slack
          });
          
          // Return immediately to Slack (within 3 seconds) to prevent retries
          // The background function will process alt text generation asynchronously
          return {
            statusCode: 200,
            body: JSON.stringify({ ok: true }),
          };
        }
      }

      // Return to Slack immediately for messages without images needing alt text
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
