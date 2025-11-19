import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { createHmac } from 'crypto';
import { WebClient, ChatPostEphemeralArguments } from '@slack/web-api';
import { generateResponseText, getImageNamesWithMissingAltText, getImagesWithMissingAltText, generateAltTextSuggestion } from '../../src/utils';

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
  
  const imagesMissingAltText = getImagesWithMissingAltText(event.files);
  const filesnamesMissingAltText: string[] = getImageNamesWithMissingAltText(
    event.files
  );
  
  console.log('Images missing alt text:', filesnamesMissingAltText);

  if (filesnamesMissingAltText.length > 0) {
    console.log(`[Message Handler] Found ${filesnamesMissingAltText.length} image(s) missing alt text, starting alt text generation`);
    
    // Generate alt text suggestions for each image
    const altTextSuggestions = new Map<string, string | null>();
    const generationStartTime = Date.now();
    let successCount = 0;
    let failureCount = 0;
    
    for (const file of imagesMissingAltText) {
      const imageUrl = file.url_private || file.url_private_download;
      if (imageUrl) {
        console.log(`[Message Handler] Processing image ${altTextSuggestions.size + 1}/${imagesMissingAltText.length}: ${file.name}`);
        const suggestion = await generateAltTextSuggestion(
          imageUrl,
          file.name,
          SLACK_TOKEN
        );
        altTextSuggestions.set(file.name, suggestion);
        if (suggestion) {
          successCount++;
          console.log(`[Message Handler] ✓ Successfully generated suggestion for ${file.name}`);
        } else {
          failureCount++;
          console.log(`[Message Handler] ✗ Failed to generate suggestion for ${file.name}`);
        }
      } else {
        failureCount++;
        console.warn(`[Message Handler] ✗ No image URL found for file: ${file.name}`);
        altTextSuggestions.set(file.name, null);
      }
    }

    const generationTime = Date.now() - generationStartTime;
    console.log(`[Message Handler] Alt text generation completed in ${generationTime}ms`);
    console.log(`[Message Handler] Summary: ${successCount} successful, ${failureCount} failed out of ${imagesMissingAltText.length} total`);

    const responseText = generateResponseText(event.files.length, filesnamesMissingAltText, altTextSuggestions);
    const hasSuggestions = successCount > 0;
    console.log(`[Message Handler] Generated response text (${responseText.length} chars, includes suggestions: ${hasSuggestions})`);

    const parameters: ChatPostEphemeralArguments = {
      channel: event.channel,
      user: event.user,
      text: responseText,
    };

    if (event.thread_ts) {
      parameters.thread_ts = event.thread_ts;
      console.log(`[Message Handler] Message will be sent in thread: ${event.thread_ts}`);
    }

    try {
      console.log(`[Message Handler] Sending ephemeral message to user ${event.user} in channel ${event.channel}`);
      await web.chat.postEphemeral(parameters);
      console.log(`[Message Handler] ✓ Ephemeral message sent successfully`);
    } catch (error) {
      console.error(`[Message Handler] ✗ Error sending ephemeral message:`, error);
    }
  } else {
    console.log('[Message Handler] No images missing alt text, not sending message');
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
