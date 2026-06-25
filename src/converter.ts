import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';

const execAsync = promisify(exec);

export interface ConvertPdfToPngOptions {
  /**
   * Render non-embedded standard fonts (Helvetica, Times, Courier, Symbol, ZapfDingbats)
   * using bundled URW base-35 substitutes.
   *
   * Defaults to `false`. When `false`/omitted, the `pdftoppm` environment is left
   * completely untouched, so output is byte-for-byte identical to previous versions —
   * existing consumers are unaffected. Opt in only when a PDF relies on non-embedded
   * standard fonts (otherwise text renders blank on minimal images without system fonts).
   */
  substituteFonts?: boolean;
  /**
   * Directory containing the bundled substitute fonts. Defaults to the repo's `fonts/`
   * directory. Only consulted when `substituteFonts` is `true`.
   */
  fontDir?: string;
}

// Bundled fonts live alongside the compiled output (dist/) and the source (src/),
// one level up in `fonts/`. Kept off every system/default font path on purpose so it
// can never alter rendering for callers who don't opt in.
const DEFAULT_FONT_DIR = path.resolve(__dirname, '..', 'fonts');

/**
 * Writes a self-contained fontconfig file that exposes ONLY the bundled font directory
 * and aliases the PDF base-14 font names to their URW base-35 equivalents. Passing this
 * via FONTCONFIG_FILE fully replaces the system fontconfig for that single process, so it
 * cannot leak into or be affected by the host's font setup.
 */
async function buildSubstituteFontConfig(tempDir: string, fontDir: string, id: string): Promise<{ confPath: string; cacheDir: string }> {
  // fontconfig requires absolute paths in FONTCONFIG_FILE and inside <dir>/<cachedir>;
  // a relative path makes it fail with "Cannot load default config file" and silently
  // skip substitution, so resolve everything to absolute here.
  const absFontDir = path.resolve(fontDir);
  const cacheDir = path.resolve(tempDir, `fc-cache-${id}`);
  await fs.mkdir(cacheDir, { recursive: true });
  const confPath = path.resolve(tempDir, `fonts-${id}.conf`);
  const conf = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${absFontDir}</dir>
  <cachedir>${cacheDir}</cachedir>
  <alias binding="same"><family>Helvetica</family><accept><family>Nimbus Sans</family></accept></alias>
  <alias binding="same"><family>Arial</family><accept><family>Nimbus Sans</family></accept></alias>
  <alias binding="same"><family>Times</family><accept><family>Nimbus Roman</family></accept></alias>
  <alias binding="same"><family>Times New Roman</family><accept><family>Nimbus Roman</family></accept></alias>
  <alias binding="same"><family>Courier</family><accept><family>Nimbus Mono PS</family></accept></alias>
  <alias binding="same"><family>Courier New</family><accept><family>Nimbus Mono PS</family></accept></alias>
  <alias binding="same"><family>Symbol</family><accept><family>Standard Symbols PS</family></accept></alias>
  <alias binding="same"><family>ZapfDingbats</family><accept><family>Dingbats</family></accept></alias>
</fontconfig>
`;
  await fs.writeFile(confPath, conf, 'utf8');
  return { confPath, cacheDir };
}

export async function convertPdfToPng(inputPath: string, scale: number = 1.0, options: ConvertPdfToPngOptions = {}): Promise<string> {
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

  // Only created when the caller opts in; otherwise the pdftoppm environment is untouched.
  let fontConf: { confPath: string; cacheDir: string } | undefined;

  try {
    console.log('Processing PDF with pdftoppm');
    console.log('Input file path:', inputPath);
    console.log('Output prefix:', outputPrefix);

    let execOptions: { env?: NodeJS.ProcessEnv } | undefined;
    if (options.substituteFonts) {
      const fontDir = options.fontDir ?? DEFAULT_FONT_DIR;
      fontConf = await buildSubstituteFontConfig(tempDir, fontDir, id);
      // FONTCONFIG_FILE replaces the system config for this child process only.
      execOptions = { env: { ...process.env, FONTCONFIG_FILE: fontConf.confPath } };
      console.log('Font substitution enabled, using font dir:', fontDir);
    }

    // Use pdftoppm directly to convert PDF to PNG
    const command = `pdftoppm -png "${inputPath}" "${outputPrefix}"`;
    console.log('Executing command:', command);

    const { stdout, stderr } = await execAsync(command, execOptions);

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
  } finally {
    // Best-effort cleanup of the per-call fontconfig artifacts (only present when opted in).
    if (fontConf) {
      await fs.rm(fontConf.confPath, { force: true }).catch(() => undefined);
      await fs.rm(fontConf.cacheDir, { recursive: true, force: true }).catch(() => undefined);
    }
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