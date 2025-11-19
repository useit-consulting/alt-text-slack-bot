import sharp from 'sharp';

const ALT_TEXT_API_URL = 'https://useit-alttext.netlify.app/.netlify/functions/generate-alt-text';
const ALT_TEXT_API_KEY = process.env.ALT_TEXT_GENERATION_API_KEY;

/**
 * Downloads an image from Slack and generates an alt text suggestion
 *
 * @param {string} imageUrl The private URL of the image from Slack
 * @param {string} fileName The name of the file
 * @param {string} slackToken The Slack bot token for authentication
 * @return {Promise<string | null>} The generated alt text or null if generation fails
 */
export async function generateAltTextSuggestion(
  imageUrl: string,
  fileName: string,
  slackToken: string
): Promise<string | null> {
  const startTime = Date.now();
  console.log(`[Alt Text Generation] Starting alt text generation for file: ${fileName}`);

  if (!ALT_TEXT_API_KEY) {
    console.warn('[Alt Text Generation] ALT_TEXT_GENERATION_API_KEY not set, skipping alt text generation');
    return null;
  }

  const delay = (duration: number) =>
    new Promise((resolve) => setTimeout(resolve, duration));

  const attemptRequest = async (retries = 3): Promise<string | null> => {
    const attemptStartTime = Date.now();
    const attemptNumber = 4 - retries;
    
    try {
      console.log(`[Alt Text Generation] Attempt ${attemptNumber}/3 for ${fileName}`);
      console.log(`[Alt Text Generation] Downloading image from Slack: ${imageUrl.substring(0, 50)}...`);
      
      // Download image from Slack with authentication
      const downloadStartTime = Date.now();
      const imageResponse = await fetch(imageUrl, {
        headers: {
          Authorization: `Bearer ${slackToken}`,
        },
      });

      const downloadTime = Date.now() - downloadStartTime;
      console.log(`[Alt Text Generation] Image download completed in ${downloadTime}ms, status: ${imageResponse.status}`);

      if (!imageResponse.ok) {
        const errorText = await imageResponse.text().catch(() => 'Unable to read error response');
        console.error(`[Alt Text Generation] Failed to download image: ${imageResponse.status} ${imageResponse.statusText}`, errorText);
        throw new Error(`Failed to download image: ${imageResponse.status} ${imageResponse.statusText}`);
      }

      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      const originalSize = imageBuffer.length;
      console.log(`[Alt Text Generation] Downloaded image size: ${(originalSize / 1024).toFixed(2)} KB`);

      // Resize image to 800px and convert to base64
      console.log(`[Alt Text Generation] Processing image: resizing to 800px and converting to base64`);
      const processStartTime = Date.now();
      const resizedImageBuffer = await sharp(imageBuffer).resize(800).toBuffer();
      const processedSize = resizedImageBuffer.length;
      const processTime = Date.now() - processStartTime;
      console.log(`[Alt Text Generation] Image processed in ${processTime}ms, resized size: ${(processedSize / 1024).toFixed(2)} KB (${((1 - processedSize / originalSize) * 100).toFixed(1)}% reduction)`);
      
      const imageBase64 = resizedImageBuffer.toString('base64');
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
      const response = await fetch(ALT_TEXT_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': ALT_TEXT_API_KEY,
        },
        body: JSON.stringify(payload),
      });

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
      console.error(`[Alt Text Generation] ✗ Error generating alt text for ${fileName} (attempt ${attemptNumber} took ${attemptTime}ms):`, errorMessage);
      
      if (retries > 0 && errorMessage.includes('429')) {
        console.log(`[Alt Text Generation] Rate limit error detected, retrying in 10 seconds... (${retries} retries remaining)`);
        await delay(10000);
        return attemptRequest(retries - 1);
      }
      
      if (retries === 0) {
        const totalTime = Date.now() - startTime;
        console.error(`[Alt Text Generation] ✗ Failed to generate alt text for ${fileName} after all retries (total time: ${totalTime}ms)`);
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
 * Returns text based on message file count and count of images with missing alt text
 *
 * @param {number} fileCount The total number of files shared within a single message.
 * @param {string[]} filenamesMissingAltText The total number of images missing alt text within a single message.
 * @param {Map<string, string | null>} altTextSuggestions Map of filename to alt text suggestion (null if generation failed)
 * @return {string} A generated response text.
 */
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
