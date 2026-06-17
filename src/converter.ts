import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';

const execAsync = promisify(exec);

export async function convertPdfToPng(inputPath: string, scale: number = 1.0): Promise<string> {
  const tempDir = 'temp';
  const id = randomUUID();
  const outputPath = path.join(tempDir, `output-${id}.png`);

  try {
    await fs.access(inputPath);
    const fileStats = await fs.stat(inputPath);
    console.log('Input file stats:', { size: fileStats.size, isFile: fileStats.isFile() });

    // Check if temp directory exists
    try {
      await fs.access(tempDir);
    } catch {
      await fs.mkdir(tempDir, { recursive: true });
      console.log('Created temp directory');
    }
  } catch (error) {
    throw new Error(`Input PDF file not found or not accessible: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  const outputPrefix = path.join(tempDir, `page-${id}`);
  let results: string[];

  try {
    console.log('Processing PDF with pdftoppm');
    console.log('Input file path:', inputPath);
    console.log('Output prefix:', outputPrefix);

    // Use pdftoppm directly to convert PDF to PNG
    const command = `pdftoppm -png "${inputPath}" "${outputPrefix}"`;
    console.log('Executing command:', command);

    const { stdout, stderr } = await execAsync(command);

    if (stderr) {
      console.log('pdftoppm stderr:', stderr);
    }

    console.log('pdftoppm stdout:', stdout);

    // Find generated PNG files
    const tempFiles = await fs.readdir(tempDir);
    const pngFiles = tempFiles.filter(file =>
      file.startsWith(path.basename(outputPrefix)) && file.endsWith('.png')
    ).sort();

    console.log('Generated PNG files:', pngFiles);

    if (pngFiles.length === 0) {
      throw new Error('No PNG files were generated');
    }

    // Map to full paths
    results = pngFiles.map(file => path.join(tempDir, file));

    console.log('PDF processing results:', results.length, 'pages');
  } catch (error) {
    console.error('PDF processing failed:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
    }
    throw new Error(`Failed to process PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  if (results.length === 0) {
    throw new Error('No pages found in PDF');
  }

  if (results.length === 1) {
    const singlePagePath = results[0];
    if (!singlePagePath) {
      throw new Error('Failed to get path for single page conversion');
    }
    await fs.copyFile(singlePagePath, outputPath);
    await fs.unlink(singlePagePath);
  } else {
  const images = await Promise.all(
    results.map(async (imagePath) => {
      try {
        if (!imagePath) {
          throw new Error('Failed to get path for page conversion');
        }
        const imageBuffer = await fs.readFile(imagePath);
        await fs.unlink(imagePath);
        return sharp(imageBuffer);
      } catch (error) {
        throw new Error(`Failed to process page image: ${imagePath}`);
      }
    })
  );

  const imageBuffers = await Promise.all(
    images.map(img => img.png({ quality: 100, compressionLevel: 0 }).toBuffer())
  );

  const dimensions = await Promise.all(
    imageBuffers.map(buffer => sharp(buffer).metadata().then(meta => ({ width: meta.width || 0, height: meta.height || 0 })))
  );

  const width = Math.max(...dimensions.map(d => d.width));
  const heights = dimensions.map(d => d.height);

  if (!width) {
    throw new Error('Could not determine image width');
  }

  const totalHeight = heights.reduce((sum, height) => sum + height, 0);

  let stitchedImage = sharp({
    create: {
      width,
      height: totalHeight,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  });

  const composite = [];
  let top = 0;

  for (let i = 0; i < imageBuffers.length; i++) {
    composite.push({
      input: imageBuffers[i],
      top,
      left: 0
    });
    top += heights[i];
  }

  await stitchedImage
    .composite(composite)
    .png({ quality: 100, compressionLevel: 0 })
    .toFile(outputPath);
  }

  if (scale < 1) {
    const scaledPath = outputPath + '.scaled.png';
    const meta = await sharp(outputPath).metadata();
    await sharp(outputPath)
      .resize(Math.round((meta.width || 0) * scale))
      .png({ quality: 100, compressionLevel: 0 })
      .toFile(scaledPath);
    await fs.rename(scaledPath, outputPath);
  }

  return outputPath;
}