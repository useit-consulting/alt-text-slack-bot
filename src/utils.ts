import sharp from 'sharp';

const ALT_TEXT_API_URL = 'https://useit-alttext.netlify.app/.netlify/functions/generate-alt-text';
const ALT_TEXT_API_KEY = process.env.ALT_TEXT_GENERATION_API_KEY;

/**
 * Downloads an image from Slack and generates an alt text suggestion
 *
 * @param {string} imageUrl The URL of the image from Slack (thumbnail or full-size)
 * @param {string} fileName The name of the file
 * @param {string} slackToken The Slack bot token for authentication
 * @param {boolean} isThumbnail Whether the URL is a pre-resized thumbnail (optimizes processing)
 * @return {Promise<string | null>} The generated alt text or null if generation fails
 */
export async function generateAltTextSuggestion(
  imageUrl: string,
  fileName: string,
  slackToken: string,
  isThumbnail: boolean = false
): Promise<string | null> {
  const startTime = Date.now();
  console.log(`[Alt Text Generation] Starting alt text generation for file: ${fileName}`);

  if (!ALT_TEXT_API_KEY) {
    console.warn('[Alt Text Generation] ALT_TEXT_GENERATION_API_KEY not set, skipping alt text generation');
    return null;
  }

  const delay = (duration: number) =>
    new Promise((resolve) => setTimeout(resolve, duration));

  // Helper function to add timeout to fetch
  const fetchWithTimeout = async (url: string, options: RequestInit, timeoutMs: number = 30000): Promise<Response> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.log(`[Alt Text Generation] Fetch timeout triggered after ${timeoutMs}ms, aborting request`);
      controller.abort();
    }, timeoutMs);
    
    try {
      console.log(`[Alt Text Generation] Starting fetch request with ${timeoutMs}ms timeout`);
      const fetchStartTime = Date.now();
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      const fetchTime = Date.now() - fetchStartTime;
      clearTimeout(timeoutId);
      console.log(`[Alt Text Generation] Fetch completed in ${fetchTime}ms`);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : 'Unknown';
      console.error(`[Alt Text Generation] Fetch error: ${errorName} - ${errorMessage}`);
      if (errorName === 'AbortError' || errorMessage.includes('aborted')) {
        throw new Error(`Request timeout after ${timeoutMs}ms`);
      }
      throw error;
    }
  };

  const attemptRequest = async (retries = 3): Promise<string | null> => {
    const attemptStartTime = Date.now();
    const attemptNumber = 4 - retries;
    
    try {
      console.log(`[Alt Text Generation] Attempt ${attemptNumber}/3 for ${fileName}`);
      console.log(`[Alt Text Generation] Downloading image from Slack: ${imageUrl.substring(0, 50)}...`);
      
      // Download image from Slack with authentication
      // Use reasonable timeout - thumbnails should download quickly, but allow time for larger files
      const downloadStartTime = Date.now();
      console.log(`[Alt Text Generation] Preparing to fetch image with Authorization header`);
      console.log(`[Alt Text Generation] Image URL: ${imageUrl.substring(0, 100)}...`);
      console.log(`[Alt Text Generation] Token present: ${!!slackToken}, Token starts with: ${slackToken ? slackToken.substring(0, 7) : 'N/A'}`);
      
      let imageResponse: Response;
      try {
        console.log(`[Alt Text Generation] Making fetch request with Authorization header...`);
        // Use 20 second timeout for downloads - should be plenty for thumbnails, 
        // and if it's a large file, we'll timeout gracefully
        imageResponse = await fetchWithTimeout(
          imageUrl,
          {
            headers: {
              'Authorization': `Bearer ${slackToken}`,
              'User-Agent': 'Slack-Alt-Text-Bot/1.0',
            },
          },
          20000 // 20 second timeout for downloads
        );
      } catch (fetchError) {
        const errorMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);
        console.error(`[Alt Text Generation] Fetch failed with error: ${errorMsg}`);
        throw fetchError;
      }

      const downloadTime = Date.now() - downloadStartTime;
      console.log(`[Alt Text Generation] Image download completed in ${downloadTime}ms, status: ${imageResponse.status}`);

      if (!imageResponse.ok) {
        const errorText = await imageResponse.text().catch(() => 'Unable to read error response');
        console.error(`[Alt Text Generation] Failed to download image: ${imageResponse.status} ${imageResponse.statusText}`);
        console.error(`[Alt Text Generation] Error response body: ${errorText.substring(0, 500)}`);
        
        if (imageResponse.status === 401 || imageResponse.status === 403) {
          console.error(`[Alt Text Generation] Authentication/Authorization error! Check that:`);
          console.error(`[Alt Text Generation] 1. Bot token is valid`);
          console.error(`[Alt Text Generation] 2. Bot has 'files:read' scope`);
          console.error(`[Alt Text Generation] 3. Bot has access to the file`);
        }
        
        throw new Error(`Failed to download image: ${imageResponse.status} ${imageResponse.statusText}`);
      }

      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      const originalSize = imageBuffer.length;
      console.log(`[Alt Text Generation] Downloaded image size: ${(originalSize / 1024).toFixed(2)} KB (thumbnail: ${isThumbnail})`);

      // Process image: if it's already a thumbnail, we might skip resize or do minimal processing
      let processedImageBuffer: Buffer;
      const processStartTime = Date.now();
      
      if (isThumbnail) {
        // Thumbnails are already resized and optimized by Slack
        // For thumbnails under 3MB, use as-is to avoid making them larger
        if (originalSize < 3 * 1024 * 1024) {
          console.log(`[Alt Text Generation] Thumbnail is already optimized (${(originalSize / 1024).toFixed(2)} KB), using as-is`);
          processedImageBuffer = imageBuffer;
        } else {
          // Thumbnail is very large, try to compress it
          console.log(`[Alt Text Generation] Thumbnail is very large, attempting compression`);
          try {
            const compressed = await sharp(imageBuffer)
              .resize(800, null, { withoutEnlargement: true })
              .jpeg({ quality: 80, mozjpeg: true })
              .toBuffer();
            
            // Only use compressed version if it's actually smaller
            if (compressed.length < originalSize) {
              processedImageBuffer = compressed;
            } else {
              console.log(`[Alt Text Generation] Compression didn't reduce size, using original`);
              processedImageBuffer = imageBuffer;
            }
          } catch (error) {
            console.warn(`[Alt Text Generation] Compression failed, using original:`, error);
            processedImageBuffer = imageBuffer;
          }
        }
      } else {
        // Full-size image, resize and compress
        console.log(`[Alt Text Generation] Processing full-size image: resizing to 800px and compressing`);
        processedImageBuffer = await sharp(imageBuffer)
          .resize(800, null, { withoutEnlargement: true })
          .jpeg({ quality: 85, mozjpeg: true })
          .toBuffer();
      }
      
      const processedSize = processedImageBuffer.length;
      const processTime = Date.now() - processStartTime;
      if (processedSize < originalSize) {
        const reduction = ((1 - processedSize / originalSize) * 100).toFixed(1);
        console.log(`[Alt Text Generation] Image processed in ${processTime}ms, processed size: ${(processedSize / 1024).toFixed(2)} KB (${reduction}% reduction)`);
      } else if (processedSize > originalSize) {
        const increase = ((processedSize / originalSize - 1) * 100).toFixed(1);
        console.log(`[Alt Text Generation] Image processed in ${processTime}ms, but size increased to ${(processedSize / 1024).toFixed(2)} KB (+${increase}%), using original`);
        processedImageBuffer = imageBuffer; // Use original if processing made it larger
      } else {
        console.log(`[Alt Text Generation] Image processed in ${processTime}ms, using original size: ${(processedSize / 1024).toFixed(2)} KB`);
      }
      
      const imageBase64 = processedImageBuffer.toString('base64');
      const base64Size = imageBase64.length;
      console.log(`[Alt Text Generation] Base64 encoded size: ${(base64Size / 1024).toFixed(2)} KB`);

      const payload = {
        image: imageBase64,
        fileName: fileName,
        prompt:
          'You are a helpful accessibility expert who generates descriptive alt texts for images in swedish to enable visually impaired users to perceive the image\'s subject and purpose. Focus on the most important visual elements. Do not include the word \'image\' in the alt text. Keep the text to the point, but still descriptive.',
        userPrompt:
          'Be short and concise. The text must be a maximum of 180 characters long',
        model: 'gpt-4o-mini',
        backend: 'openai',
      };

      console.log(`[Alt Text Generation] Calling alt text API: ${ALT_TEXT_API_URL}`);
      console.log(`[Alt Text Generation] Payload: fileName=${fileName}, model=${payload.model}, backend=${payload.backend}`);
      
      const apiStartTime = Date.now();
      // API typically takes 3-5 seconds per image, but we allow up to 24 seconds
      // to handle slower responses, rate limiting, or retries
      // Netlify function timeout is 26 seconds, so 24 seconds gives us buffer
      const response = await fetchWithTimeout(
        ALT_TEXT_API_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': ALT_TEXT_API_KEY,
          },
          body: JSON.stringify(payload),
        },
        24000 // 24 second timeout (API typically takes 3-5s, but allows for slower responses)
      );

      const apiTime = Date.now() - apiStartTime;
      console.log(`[Alt Text Generation] API response received in ${apiTime}ms, status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unable to read error response');
        console.error(`[Alt Text Generation] API error response: ${errorText}`);
        
        if (response.status === 429 && retries > 0) {
          console.log(`[Alt Text Generation] Rate limit exceeded (429), retrying in 10 seconds... (${retries} retries remaining)`);
          await delay(10000);
          return attemptRequest(retries - 1);
        }
        throw new Error(`API Error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const altText = data.altText || null;
      const totalTime = Date.now() - startTime;
      const attemptTime = Date.now() - attemptStartTime;
      
      if (altText) {
        console.log(`[Alt Text Generation] ✓ Successfully generated alt text for ${fileName} in ${totalTime}ms (attempt took ${attemptTime}ms)`);
        console.log(`[Alt Text Generation] Generated alt text (${altText.length} chars): "${altText}"`);
      } else {
        console.warn(`[Alt Text Generation] API returned success but no altText in response for ${fileName}`);
        console.log(`[Alt Text Generation] API response data:`, JSON.stringify(data));
      }
      
      return altText;
    } catch (error) {
      const attemptTime = Date.now() - attemptStartTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isTimeout = errorMessage.includes('timeout') || errorMessage.includes('AbortError');
      
      console.error(`[Alt Text Generation] ✗ Error generating alt text for ${fileName} (attempt ${attemptNumber} took ${attemptTime}ms):`, errorMessage);
      
      if (isTimeout) {
        console.error(`[Alt Text Generation] Request timeout detected - this may be due to slow network or large image size`);
      }
      
      if (retries > 0 && (errorMessage.includes('429') || isTimeout)) {
        const retryDelay = isTimeout ? 5000 : 10000; // Shorter delay for timeouts
        console.log(`[Alt Text Generation] Retrying in ${retryDelay / 1000} seconds... (${retries} retries remaining)`);
        await delay(retryDelay);
        return attemptRequest(retries - 1);
      }
      
      if (retries === 0) {
        const totalTime = Date.now() - startTime;
        console.error(`[Alt Text Generation] ✗ Failed to generate alt text for ${fileName} after all retries (total time: ${totalTime}ms)`);
        if (isTimeout) {
          console.error(`[Alt Text Generation] Final failure due to timeout - consider using smaller images or increasing function timeout`);
        }
      }
      
      return null;
    }
  };

  return attemptRequest();
}

/**
 * Returns an array of image names with missing alt text
 *
 * @param {any[]} files An array of file objects retrieved by the Slack API
 * @return {string[]} An array of filenames that are images with missing alt text.
 */
 export const getImageNamesWithMissingAltText = (files: any[]): string[] => {
  return files.filter((file: any) => {
    return(file.mimetype.includes('image') && file.alt_txt === undefined)
  }).map((file: any) => { return file.name })
}

/**
 * Returns an array of file objects that are images with missing alt text
 *
 * @param {any[]} files An array of file objects retrieved by the Slack API
 * @return {any[]} An array of file objects that are images with missing alt text.
 */
export const getImagesWithMissingAltText = (files: any[]): any[] => {
  return files.filter((file: any) => {
    return(file.mimetype.includes('image') && file.alt_txt === undefined)
  })
}

/**
 * Selects the best thumbnail URL from a Slack file object
 * Prefers smaller pre-resized thumbnails over the full-size image for faster downloads
 *
 * @param {any} file A file object from the Slack API
 * @return {string | null} The best thumbnail URL to use, or null if none available
 */
export const getBestThumbnailUrl = (file: any): string | null => {
  // Prefer thumb_800 (matches our target resize size), then fall back to smaller ones
  // Order: thumb_800 > thumb_720 > thumb_480 > thumb_360 > full size
  if (file.thumb_800) {
    console.log(`[Thumbnail Selection] Using thumb_800 for ${file.name}`);
    return file.thumb_800;
  }
  if (file.thumb_720) {
    console.log(`[Thumbnail Selection] Using thumb_720 for ${file.name}`);
    return file.thumb_720;
  }
  if (file.thumb_480) {
    console.log(`[Thumbnail Selection] Using thumb_480 for ${file.name}`);
    return file.thumb_480;
  }
  if (file.thumb_360) {
    console.log(`[Thumbnail Selection] Using thumb_360 for ${file.name}`);
    return file.thumb_360;
  }
  // Fall back to full-size image as last resort
  if (file.url_private || file.url_private_download) {
    console.log(`[Thumbnail Selection] No thumbnail available, using full-size image for ${file.name}`);
    return file.url_private || file.url_private_download;
  }
  console.warn(`[Thumbnail Selection] No image URL found for ${file.name}`);
  return null;
}

/**
 * Returns text based on message file count and count of images with missing alt text
 *
 * @param {number} fileCount The total number of files shared within a single message.
 * @param {string[]} filenamesMissingAltText The total number of images missing alt text within a single message.
 * @param {Map<string, string | null>} altTextSuggestions Map of filename to alt text suggestion (null if generation failed)
 * @return {string} A generated response text.
 */
/**
 * Handles the complete alt text generation workflow
 * This can be called directly without HTTP invocation
 */
// Simple in-memory cache to prevent duplicate processing
// In production, you might want to use Redis or similar
const processedEvents = new Set<string>();

export async function handleAltTextGeneration(
  slackEvent: any,
  slackToken: string,
  webClient: any
): Promise<void> {
  // Create a unique key for this event to prevent duplicate processing
  // Use event_ts + channel + user to uniquely identify the event
  const eventKey = `${slackEvent.event_ts || slackEvent.ts}_${slackEvent.channel}_${slackEvent.user}`;
  
  if (processedEvents.has(eventKey)) {
    console.log(`[Alt Text Handler] Event already processed: ${eventKey}, skipping`);
    return;
  }
  
  // Mark as processing (add to set)
  processedEvents.add(eventKey);
  
  // Clean up old entries (keep last 1000)
  if (processedEvents.size > 1000) {
    const entries = Array.from(processedEvents);
    entries.slice(0, entries.length - 1000).forEach(key => processedEvents.delete(key));
  }
  
  console.log('[Alt Text Handler] Starting alt text generation workflow');
  
  // Ignore bot messages and messages without files
  if (slackEvent.subtype === 'bot_message') {
    console.log('[Alt Text Handler] Ignoring bot message');
    processedEvents.delete(eventKey); // Remove if we're not processing
    return;
  }

  if (!slackEvent.files) {
    console.log('[Alt Text Handler] Message has no files');
    processedEvents.delete(eventKey); // Remove if we're not processing
    return;
  }

  const imagesMissingAltText = getImagesWithMissingAltText(slackEvent.files);
  const filesnamesMissingAltText = getImageNamesWithMissingAltText(slackEvent.files);

  console.log(`[Alt Text Handler] Found ${filesnamesMissingAltText.length} image(s) missing alt text`);

  if (filesnamesMissingAltText.length === 0) {
    console.log('[Alt Text Handler] No images missing alt text');
    processedEvents.delete(eventKey); // Remove if we're not processing
    return;
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
      console.log(`[Alt Text Handler] Processing image: ${file.name} (using ${isThumbnail ? 'thumbnail' : 'full-size'})`);
      
      try {
        const suggestion = await generateAltTextSuggestion(
          imageUrl,
          file.name,
          slackToken,
          isThumbnail
        );
        altTextSuggestions.set(file.name, suggestion);
        if (suggestion) {
          successCount++;
          console.log(`[Alt Text Handler] ✓ Generated suggestion for ${file.name}`);
        } else {
          failureCount++;
          console.log(`[Alt Text Handler] ✗ Failed to generate suggestion for ${file.name}`);
        }
      } catch (error) {
        failureCount++;
        console.error(`[Alt Text Handler] ✗ Exception generating suggestion for ${file.name}:`, error);
        altTextSuggestions.set(file.name, null);
      }
    } else {
      failureCount++;
      console.warn(`[Alt Text Handler] ✗ No image URL found for file: ${file.name}`);
      altTextSuggestions.set(file.name, null);
    }
  }

  const generationTime = Date.now() - generationStartTime;
  console.log(`[Alt Text Handler] Alt text generation completed in ${generationTime}ms`);
  console.log(`[Alt Text Handler] Summary: ${successCount} successful, ${failureCount} failed`);

  // Send message with suggestions
  const responseText = generateResponseText(slackEvent.files.length, filesnamesMissingAltText, altTextSuggestions);
  const hasSuggestions = successCount > 0;
  console.log(`[Alt Text Handler] Generated response text (${responseText.length} chars, includes suggestions: ${hasSuggestions})`);

  const parameters = {
    channel: slackEvent.channel,
    user: slackEvent.user,
    text: responseText,
    ...(slackEvent.thread_ts && { thread_ts: slackEvent.thread_ts }),
  };

  try {
    console.log(`[Alt Text Handler] Sending ephemeral message to user ${slackEvent.user} in channel ${slackEvent.channel}`);
    await webClient.chat.postEphemeral(parameters);
    console.log(`[Alt Text Handler] ✓ Ephemeral message sent successfully`);
  } catch (error) {
    console.error(`[Alt Text Handler] ✗ Error sending ephemeral message:`, error);
    // Don't remove from processedEvents on error - we want to retry on next Slack retry
    // But if it's a "message already sent" error, we can remove it
    if (error instanceof Error && error.message.includes('already_exists')) {
      processedEvents.delete(eventKey);
    }
    throw error;
  }
}

export const generateResponseText = (
  fileCount: number,
  filesnamesMissingAltText: string[],
  altTextSuggestions?: Map<string, string | null>
): string => {
  const instructions = `On Desktop, activate the *More actions* menu on the image, choose *Edit file details*, and modify the `+
  `*Description* field to add alt text. On Android, long press the image and select *Add description*. If adding alt is not supported on your device,`+
  ` simply provide alt text in a follow-up message. ❤️`

  let suggestionText = '';
  if (altTextSuggestions && altTextSuggestions.size > 0) {
    const suggestions: string[] = [];
    filesnamesMissingAltText.forEach((filename) => {
      const suggestion = altTextSuggestions.get(filename);
      if (suggestion) {
        suggestions.push(`*${filename}:*\n\`\`\`${suggestion}\`\`\``);
      }
    });
    
    if (suggestions.length > 0) {
      suggestionText = `\n\n*Here's a suggestion:*\n${suggestions.join('\n\n')}\n`;
    }
  }

  if (fileCount === 1) {
    return `Uh oh! The image you shared is missing alt text so it won't be accessible to your teammates `+
    `who are blind or have low-vision.${suggestionText}\n\n`+ instructions
  } else {
    const joinedFileNames = filesnamesMissingAltText.map(name => `\`${name}\``).join(', ')
    return `Uh oh! The following images are missing alt text: ${joinedFileNames}. `+
    `This means it won't be accessible to your teammates who are blind or have low-vision.${suggestionText}\n\n`+
    instructions
  }
}
