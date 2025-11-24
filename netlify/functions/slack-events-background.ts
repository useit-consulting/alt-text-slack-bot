import { Handler, HandlerEvent } from '@netlify/functions';
import { WebClient } from '@slack/web-api';
import { handleAltTextGeneration } from '../../src/utils';

const SLACK_TOKEN = process.env.SLACK_TOKEN;

if (!SLACK_TOKEN) {
  throw new Error('SLACK_TOKEN must be set');
}

const web = new WebClient(SLACK_TOKEN);

/**
 * Background function handler for processing Slack events asynchronously
 * This function can run for up to 15 minutes, allowing alt text generation to complete
 */
export const handler: Handler = async (event: HandlerEvent) => {
  console.log('[Background Handler] Starting background processing');
  
  try {
    // Parse the event payload
    const payload = JSON.parse(event.body || '{}');
    const { slackEvent, eventId } = payload;
    
    if (!slackEvent) {
      console.error('[Background Handler] No slackEvent in payload');
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing slackEvent in payload' }),
      };
    }
    
    console.log('[Background Handler] Processing event:', eventId || 'no event_id');
    console.log('[Background Handler] slackEvent has files:', !!slackEvent.files, `(${slackEvent.files?.length || 0} files)`);
    
    // Verify we have the necessary context
    if (!slackEvent.files || slackEvent.files.length === 0) {
      console.error('[Background Handler] No files in slackEvent - cannot process alt text');
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No files in slackEvent' }),
      };
    }
    
    // Verify we have SLACK_TOKEN
    if (!SLACK_TOKEN) {
      console.error('[Background Handler] SLACK_TOKEN not set in environment');
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'SLACK_TOKEN not configured' }),
      };
    }
    
    // Log file details to verify URLs are present
    slackEvent.files.forEach((file: any, index: number) => {
      const hasUrl = file.thumb_800 || file.thumb_720 || file.thumb_480 || file.thumb_360 || file.url_private || file.url_private_download;
      console.log(`[Background Handler] File ${index + 1}: ${file.name}, has URL: ${!!hasUrl}, mimetype: ${file.mimetype}`);
    });
    
    // Process alt text generation
    // This can take 5-10 seconds but the background function won't be terminated
    await handleAltTextGeneration(slackEvent, SLACK_TOKEN, web, eventId);
    
    console.log('[Background Handler] Alt text generation completed successfully');
    
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true }),
    };
  } catch (error) {
    console.error('[Background Handler] Error processing event:', error);
    // Return 200 anyway - we don't want to retry background functions
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, error: error instanceof Error ? error.message : String(error) }),
    };
  }
};

