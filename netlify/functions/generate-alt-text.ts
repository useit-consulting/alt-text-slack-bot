import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { WebClient, ChatPostEphemeralArguments } from '@slack/web-api';
import { generateResponseText, getImageNamesWithMissingAltText, getImagesWithMissingAltText, generateAltTextSuggestion, getBestThumbnailUrl } from '../../src/utils';

const SLACK_TOKEN = process.env.SLACK_TOKEN;

if (!SLACK_TOKEN) {
  throw new Error('SLACK_TOKEN must be set');
}

const web = new WebClient(SLACK_TOKEN);

/**
 * Background function to generate alt text and send message
 * This runs asynchronously after slack-events responds to Slack
 */
export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext
) => {
  console.log('[Background Function] ===== FUNCTION INVOKED =====');
  console.log('[Background Function] Event method:', event.httpMethod);
  console.log('[Background Function] Event path:', event.path);
  console.log('[Background Function] Event body length:', event.body?.length || 0);
  console.log('[Background Function] Event body preview:', event.body?.substring(0, 200) || 'empty');
  
  // Parse the event data passed from slack-events
  let eventData;
  try {
    const bodyString = event.body || '{}';
    console.log('[Background Function] Parsing body:', bodyString.substring(0, 500));
    eventData = JSON.parse(bodyString);
    console.log('[Background Function] Parsed eventData keys:', Object.keys(eventData));
  } catch (error) {
    console.error('[Background Function] Failed to parse event data:', error);
    console.error('[Background Function] Error details:', error instanceof Error ? error.message : String(error));
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid event data', details: error instanceof Error ? error.message : String(error) }),
    };
  }

  if (!eventData || !eventData.event) {
    console.error('[Background Function] Missing event data or event property');
    console.error('[Background Function] eventData:', JSON.stringify(eventData, null, 2));
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing event data' }),
    };
  }

  const slackEvent = eventData.event;
  console.log('[Background Function] Processing event type:', slackEvent?.type);
  console.log('[Background Function] Event has files:', !!slackEvent?.files);

  // Ignore bot messages and messages without files
  if (slackEvent.subtype === 'bot_message') {
    console.log('[Background Function] Ignoring bot message');
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, message: 'Bot message ignored' }),
    };
  }

  if (!slackEvent.files) {
    console.log('[Background Function] Message has no files');
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, message: 'No files in message' }),
    };
  }

  const imagesMissingAltText = getImagesWithMissingAltText(slackEvent.files);
  const filesnamesMissingAltText = getImageNamesWithMissingAltText(slackEvent.files);

  console.log(`[Background Function] Found ${filesnamesMissingAltText.length} image(s) missing alt text`);

  if (filesnamesMissingAltText.length === 0) {
    console.log('[Background Function] No images missing alt text');
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, message: 'No images need alt text' }),
    };
  }

  // Generate alt text suggestions for each image
  const altTextSuggestions = new Map<string, string | null>();
  const generationStartTime = Date.now();
  let successCount = 0;
  let failureCount = 0;

  for (const file of imagesMissingAltText) {
    const imageUrl = getBestThumbnailUrl(file);
    if (imageUrl) {
      const isThumbnail = imageUrl.includes('files-tmb');
      console.log(`[Background Function] Processing image: ${file.name} (using ${isThumbnail ? 'thumbnail' : 'full-size'})`);
      
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
          console.log(`[Background Function] ✓ Generated suggestion for ${file.name}`);
        } else {
          failureCount++;
          console.log(`[Background Function] ✗ Failed to generate suggestion for ${file.name}`);
        }
      } catch (error) {
        failureCount++;
        console.error(`[Background Function] ✗ Exception generating suggestion for ${file.name}:`, error);
        altTextSuggestions.set(file.name, null);
      }
    } else {
      failureCount++;
      console.warn(`[Background Function] ✗ No image URL found for file: ${file.name}`);
      altTextSuggestions.set(file.name, null);
    }
  }

  const generationTime = Date.now() - generationStartTime;
  console.log(`[Background Function] Alt text generation completed in ${generationTime}ms`);
  console.log(`[Background Function] Summary: ${successCount} successful, ${failureCount} failed`);

  // Send message with suggestions
  const responseText = generateResponseText(slackEvent.files.length, filesnamesMissingAltText, altTextSuggestions);
  const hasSuggestions = successCount > 0;
  console.log(`[Background Function] Generated response text (${responseText.length} chars, includes suggestions: ${hasSuggestions})`);

  const parameters: ChatPostEphemeralArguments = {
    channel: slackEvent.channel,
    user: slackEvent.user,
    text: responseText,
  };

  if (slackEvent.thread_ts) {
    parameters.thread_ts = slackEvent.thread_ts;
    console.log(`[Background Function] Message will be sent in thread: ${slackEvent.thread_ts}`);
  }

  try {
    console.log(`[Background Function] Sending ephemeral message to user ${slackEvent.user} in channel ${slackEvent.channel}`);
    await web.chat.postEphemeral(parameters);
    console.log(`[Background Function] ✓ Ephemeral message sent successfully`);
  } catch (error) {
    console.error(`[Background Function] ✗ Error sending ephemeral message:`, error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to send message' }),
    };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ 
      ok: true, 
      successCount, 
      failureCount,
      totalTime: Date.now() - generationStartTime 
    }),
  };
};

