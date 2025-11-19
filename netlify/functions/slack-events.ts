import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { createHmac } from 'crypto';
import { WebClient, ChatPostEphemeralArguments } from '@slack/web-api';
import { generateResponseText, getImageNamesWithMissingAltText, getImagesWithMissingAltText, generateAltTextSuggestion, getBestThumbnailUrl } from '../../src/utils';

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
    
    // Generate alt text suggestions for each image with overall timeout protection
    const altTextSuggestions = new Map<string, string | null>();
    const generationStartTime = Date.now();
    const MAX_GENERATION_TIME = 20000; // 20 seconds max for all generation work
    let successCount = 0;
    let failureCount = 0;
    
    // Wrap generation in a timeout to ensure we don't hang forever
    const generationPromise = (async () => {
      for (const file of imagesMissingAltText) {
        const elapsed = Date.now() - generationStartTime;
        if (elapsed > MAX_GENERATION_TIME) {
          console.warn(`[Message Handler] Generation timeout approaching (${elapsed}ms), stopping generation`);
          break;
        }
        
        const imageUrl = getBestThumbnailUrl(file);
        if (imageUrl) {
          // Thumbnails have URLs like files-tmb, full-size images have files-pri
          const isThumbnail = imageUrl.includes('files-tmb');
          console.log(`[Message Handler] Processing image ${altTextSuggestions.size + 1}/${imagesMissingAltText.length}: ${file.name} (using ${isThumbnail ? 'thumbnail' : 'full-size'})`);
          try {
            const suggestion = await generateAltTextSuggestion(
              imageUrl,
              file.name,
              SLACK_TOKEN,
              isThumbnail
            );
            altTextSuggestions.set(file.name, suggestion);
            if (suggestion) {
              successCount++;
              console.log(`[Message Handler] ✓ Successfully generated suggestion for ${file.name}`);
            } else {
              failureCount++;
              console.log(`[Message Handler] ✗ Failed to generate suggestion for ${file.name}`);
            }
          } catch (error) {
            failureCount++;
            console.error(`[Message Handler] ✗ Exception generating suggestion for ${file.name}:`, error);
            altTextSuggestions.set(file.name, null);
          }
        } else {
          failureCount++;
          console.warn(`[Message Handler] ✗ No image URL found for file: ${file.name}`);
          altTextSuggestions.set(file.name, null);
        }
      }
    })();
    
    // Wait for generation with timeout
    try {
      await Promise.race([
        generationPromise,
        new Promise((resolve) => setTimeout(() => {
          console.warn(`[Message Handler] Generation timeout after ${MAX_GENERATION_TIME}ms, proceeding with available results`);
          resolve(null);
        }, MAX_GENERATION_TIME))
      ]);
    } catch (error) {
      console.error(`[Message Handler] Error during generation:`, error);
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
      
      // Start the work immediately (don't await - let it run in background)
      const workPromise = handleMessageEvent(slackEvent).catch((error) => {
        console.error('[Handler] Error processing message event:', error);
      });
      
      // Attach work promise to context to keep execution context alive
      // This ensures Netlify doesn't kill the function while work is in progress
      if (context && typeof context === 'object') {
        (context as any).backgroundWork = workPromise;
      }
      
      // Respond to Slack immediately (within 3 second requirement)
      // The work will continue in the background
      // Netlify should keep the context alive as long as there are pending promises
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
