import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const ALT_TEXT_API_URL = 'https://useit-alttext.netlify.app/.netlify/functions/generate-alt-text';
const ALT_TEXT_API_KEY = process.env.ALT_TEXT_GENERATION_API_KEY;

async function testAltTextAPI() {
  if (!ALT_TEXT_API_KEY) {
    console.error('ALT_TEXT_GENERATION_API_KEY environment variable is required');
    process.exit(1);
  }

  const imagePath = path.join(__dirname, 'PXL_20250906_121523410.jpg');
  
  if (!fs.existsSync(imagePath)) {
    console.error(`Image not found: ${imagePath}`);
    process.exit(1);
  }

  console.log(`Testing alt text API with image: ${imagePath}`);
  console.log(`API URL: ${ALT_TEXT_API_URL}`);
  console.log(`API Key present: ${!!ALT_TEXT_API_KEY}`);

  try {
    // Read and process image
    console.log('\n1. Reading image...');
    const imageBuffer = fs.readFileSync(imagePath);
    const originalSize = imageBuffer.length;
    console.log(`   Original size: ${(originalSize / 1024).toFixed(2)} KB`);

    // Resize if needed
    console.log('\n2. Processing image...');
    const resizedImageBuffer = await sharp(imageBuffer).resize(800, null, { withoutEnlargement: true }).toBuffer();
    const processedSize = resizedImageBuffer.length;
    console.log(`   Processed size: ${(processedSize / 1024).toFixed(2)} KB`);

    // Convert to base64
    console.log('\n3. Encoding to base64...');
    const imageBase64 = resizedImageBuffer.toString('base64');
    const base64Size = imageBase64.length;
    console.log(`   Base64 size: ${(base64Size / 1024).toFixed(2)} KB`);

    // Prepare payload
    const payload = {
      image: imageBase64,
      fileName: path.basename(imagePath),
      prompt:
        'Du är en hjälpsam tillgänglighetsexpert som genererar beskrivande alt-texter för bilder på svenska för att göra det möjligt för synskadade användare att uppfatta bildens motiv och syfte. Fokusera på de viktigaste visuella elementen. Inkludera inte ordet "bild" i alt-texten. Håll texten kortfattad.',
      userPrompt:
        'Skriv begriplig svenska med enkla ord. Texten får inte vara längre än 180 tecken.',
      model: 'gpt-4.1',
      backend: 'openai',
    };

    // Call API
    console.log('\n4. Calling alt text API...');
    const startTime = Date.now();
    const response = await fetch(ALT_TEXT_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': ALT_TEXT_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    const elapsed = Date.now() - startTime;
    console.log(`   Response received in ${elapsed}ms`);
    console.log(`   Status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`   Error: ${errorText}`);
      process.exit(1);
    }

    const data = await response.json();
    console.log('\n5. API Response:');
    console.log(JSON.stringify(data, null, 2));

    if (data.altText) {
      console.log(`\n✓ Success! Generated alt text (${data.altText.length} chars):`);
      console.log(`  "${data.altText}"`);
    } else {
      console.log('\n✗ No alt text in response');
      process.exit(1);
    }
  } catch (error) {
    console.error('\n✗ Error:', error);
    process.exit(1);
  }
}

testAltTextAPI();

