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
  /**
   * Also supply the generic-family fallback layer that a full fontconfig installation
   * provides, so a font family the bundled config does not name by hand resolves to a text
   * face instead of to URW Dingbats.
   *
   * Defaults to `false`. When `false`/omitted the generated fontconfig file is byte-for-byte
   * what previous versions wrote, so `substituteFonts` output does not change for any
   * existing caller. Only consulted when `substituteFonts` is `true`.
   *
   * Opt in when a PDF names non-embedded fonts beyond the base-14 set — ArialNarrow, Tahoma,
   * Verdana, Calibri and the like. Note that turning it on also stops an unnamed family
   * reaching the Dingbats face at all, which is the one behaviour a PDF asking for symbols by
   * an unaliased name relied on.
   */
  fontFallback?: boolean;
  /**
   * zlib compression level for the returned PNG, an integer from 0 to 9.
   *
   * Defaults to `0`, which is what every previous version used, so omitting it keeps
   * output byte-for-byte identical, and existing consumers are unaffected. PNG is lossless
   * at every level: the pixels are the same, only the file size changes. Level 0 stores the
   * raster uncompressed, at roughly one byte per pixel. Measured on an 8-page A4 order at
   * full scale, level 0 produced 16.6 MB and level 6 produced the same pixels in 1.33 MB.
   */
  compressionLevel?: number;
}

/** One rendered page. `path` is a file in `temp/` that the caller is responsible for removing. */
export interface PdfPageImage {
  path: string;
  /** 1-based page number, in document order. */
  page: number;
  width: number;
  height: number;
}

// Bundled fonts live alongside the compiled output (dist/) and the source (src/),
// one level up in `fonts/`. Kept off every system/default font path on purpose so it
// can never alter rendering for callers who don't opt in.
const DEFAULT_FONT_DIR = path.resolve(__dirname, '..', 'fonts');

const TEMP_DIR = 'temp';

/**
 * Per-page output returns every page in one response, so an uncompressed encoding scales
 * badly: a 104-page A4 document measured 216 MB of PNG, which becomes a 288 MB JSON body
 * once base64-encoded. At level 6 the same pages are 17 MB. Per-page output is new, so no
 * existing caller can be affected by this default, and `compressionLevel` still overrides it.
 */
const PER_PAGE_DEFAULT_COMPRESSION_LEVEL = 6;

/**
 * Font families that a PDF may name without embedding, and the bundled face each should
 * resolve to. Only consulted when `fontFallback` is on. Kept separate from the base-14
 * aliases above it so the opt-out path can emit the historical config unchanged.
 */
const EXTRA_FAMILY_ALIASES: ReadonlyArray<readonly [string, string]> = [
  // Condensed faces, so a narrow family keeps its width instead of widening to the regular
  // sans via the catch-all. Poppler strips the ",Style" suffix off a PDF BaseFont and asks
  // for the family unspaced, so "ArialNarrow" is the spelling that actually arrives; the
  // spaced spellings are here for callers that normalise it.
  ['ArialNarrow', 'Nimbus Sans Narrow'],
  ['Arial Narrow', 'Nimbus Sans Narrow'],
  ['HelveticaNarrow', 'Nimbus Sans Narrow'],
  ['Helvetica Narrow', 'Nimbus Sans Narrow'],
  // URW's ZapfDingbats clone reports its family as "D050000L", not "Dingbats", so the
  // long-standing ZapfDingbats alias above matches no bundled font. It resolved correctly
  // only because an unmatched family fell through to D050000L by accident — the same
  // accident this mode removes. Re-point it by the real family name, or turning the
  // fallback on would silently replace genuine dingbats with letters.
  ['ZapfDingbats', 'D050000L'],
  ['Dingbats', 'D050000L'],
  // The generic families, which the bundled directory does not define on its own.
  ['sans-serif', 'Nimbus Sans'],
  ['serif', 'Nimbus Roman'],
  ['monospace', 'Nimbus Mono PS'],
];

function aliasLine(family: string, accept: string): string {
  return `  <alias binding="same"><family>${family}</family><accept><family>${accept}</family></accept></alias>`;
}

/**
 * The fallback layer a full fontconfig installation supplies in 49-sansserif.conf: append a
 * weak sans-serif to any pattern that names no generic family, so an unmatched family ends
 * up on a text face. It has to PRECEDE the generic aliases, exactly as Debian's numbering
 * (49 before 60) arranges it — fontconfig applies pattern rules in document order, so a
 * sans-serif appended after the sans-serif alias has already run is never expanded.
 */
const GENERIC_FALLBACK_RULE = `  <match target="pattern">
    <test qual="all" name="family" compare="not_eq"><string>sans-serif</string></test>
    <test qual="all" name="family" compare="not_eq"><string>serif</string></test>
    <test qual="all" name="family" compare="not_eq"><string>monospace</string></test>
    <edit name="family" mode="append_last" binding="weak"><string>sans-serif</string></edit>
  </match>`;

/**
 * Writes a self-contained fontconfig file that exposes ONLY the bundled font directory
 * and aliases the PDF base-14 font names to their URW base-35 equivalents. Passing this
 * via FONTCONFIG_FILE fully replaces the system fontconfig for that single process, so it
 * cannot leak into or be affected by the host's font setup.
 *
 * With `fontFallback` off — the default — the emitted file is byte-for-byte what previous
 * versions wrote, so every existing caller renders exactly the same pixels.
 *
 * With `fontFallback` on, the file also carries the generic-family fallback layer that a
 * full fontconfig installation would have provided. Without that layer a family this file
 * does not name matches nothing, and fontconfig returns whatever sorts first in the bundled
 * directory, which is `D050000L` — URW's ZapfDingbats clone. A customer PDF referencing
 * non-embedded ArialNarrow and Tahoma therefore rendered its order lines, quantities and
 * dimensions as dingbats while its aliased Arial runs rendered correctly, and pdftoppm
 * exited 0 with no warning.
 */
export async function buildSubstituteFontConfig(
  tempDir: string,
  fontDir: string,
  id: string,
  fontFallback: boolean = false,
): Promise<{ confPath: string; cacheDir: string }> {
  // fontconfig requires absolute paths in FONTCONFIG_FILE and inside <dir>/<cachedir>;
  // a relative path makes it fail with "Cannot load default config file" and silently
  // skip substitution, so resolve everything to absolute here.
  const absFontDir = path.resolve(fontDir);
  const cacheDir = path.resolve(tempDir, `fc-cache-${id}`);
  await fs.mkdir(cacheDir, { recursive: true });
  const confPath = path.resolve(tempDir, `fonts-${id}.conf`);

  // Everything below this point must stay byte-identical when fontFallback is off.
  const base14 = [
    aliasLine('Helvetica', 'Nimbus Sans'),
    aliasLine('Arial', 'Nimbus Sans'),
    aliasLine('Times', 'Nimbus Roman'),
    aliasLine('Times New Roman', 'Nimbus Roman'),
    aliasLine('Courier', 'Nimbus Mono PS'),
    aliasLine('Courier New', 'Nimbus Mono PS'),
    aliasLine('Symbol', 'Standard Symbols PS'),
  ];
  // Historical line, kept verbatim on the default path even though it matches no bundled
  // font (see EXTRA_FAMILY_ALIASES); replacing it unconditionally would change output for
  // callers who never asked for the new behaviour.
  const legacyDingbats = aliasLine('ZapfDingbats', 'Dingbats');

  const lines = fontFallback
    ? [...base14, GENERIC_FALLBACK_RULE, ...EXTRA_FAMILY_ALIASES.map(([f, a]) => aliasLine(f, a))]
    : [...base14, legacyDingbats];

  const conf = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${absFontDir}</dir>
  <cachedir>${cacheDir}</cachedir>
${lines.join('\n')}
</fontconfig>
`;
  await fs.writeFile(confPath, conf, 'utf8');
  return { confPath, cacheDir };
}

/**
 * PNG encoding settings for whatever the caller asked for. With no options this is exactly
 * what every previous version passed, so the encoded bytes do not change.
 */
function pngOptions(options: ConvertPdfToPngOptions): sharp.PngOptions {
  const compressionLevel = options.compressionLevel ?? 0;
  if (!Number.isInteger(compressionLevel) || compressionLevel < 0 || compressionLevel > 9) {
    throw new Error('compressionLevel must be an integer between 0 and 9');
  }
  return { quality: 100, compressionLevel };
}

async function ensureInputAndTempDir(inputPath: string): Promise<void> {
  try {
    await fs.access(inputPath);
    const fileStats = await fs.stat(inputPath);
    console.log('Input file stats:', { size: fileStats.size, isFile: fileStats.isFile() });

    // Check if temp directory exists
    try {
      await fs.access(TEMP_DIR);
    } catch {
      await fs.mkdir(TEMP_DIR, { recursive: true });
      console.log('Created temp directory');
    }
  } catch (error) {
    throw new Error(`Input PDF file not found or not accessible: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Renders every page of the PDF to its own PNG in `temp/` and returns the paths in page
 * order. This is the step `pdftoppm` performs natively; both the stitched and the per-page
 * entry points below build on it.
 */
async function renderPdfPages(inputPath: string, id: string, options: ConvertPdfToPngOptions): Promise<string[]> {
  const outputPrefix = path.join(TEMP_DIR, `page-${id}`);

  // Only created when the caller opts in; otherwise the pdftoppm environment is untouched.
  let fontConf: { confPath: string; cacheDir: string } | undefined;

  try {
    console.log('Processing PDF with pdftoppm');
    console.log('Input file path:', inputPath);
    console.log('Output prefix:', outputPrefix);

    let execOptions: { env?: NodeJS.ProcessEnv } | undefined;
    if (options.substituteFonts) {
      const fontDir = options.fontDir ?? DEFAULT_FONT_DIR;
      fontConf = await buildSubstituteFontConfig(TEMP_DIR, fontDir, id, options.fontFallback === true);
      // FONTCONFIG_FILE replaces the system config for this child process only.
      execOptions = { env: { ...process.env, FONTCONFIG_FILE: fontConf.confPath } };
      console.log('Font substitution enabled, using font dir:', fontDir,
        options.fontFallback === true ? '(with generic fallback)' : '(base-14 aliases only)');
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
    const tempFiles = await fs.readdir(TEMP_DIR);
    const pngFiles = tempFiles.filter(file =>
      file.startsWith(path.basename(outputPrefix)) && file.endsWith('.png')
    ).sort();

    console.log('Generated PNG files:', pngFiles);

    if (pngFiles.length === 0) {
      throw new Error('No PNG files were generated');
    }

    // Map to full paths
    const results = pngFiles.map(file => path.join(TEMP_DIR, file));

    console.log('PDF processing results:', results.length, 'pages');
    return results;
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
}

export async function convertPdfToPng(inputPath: string, scale: number = 1.0, options: ConvertPdfToPngOptions = {}): Promise<string> {
  const id = randomUUID();
  const outputPath = path.join(TEMP_DIR, `output-${id}.png`);
  const encode = pngOptions(options);
  // Only re-encode a single page when the caller asked for a specific encoding. Otherwise
  // pdftoppm's own file is copied through untouched, exactly as before.
  const reencodeSinglePage = options.compressionLevel !== undefined;

  await ensureInputAndTempDir(inputPath);

  const results = await renderPdfPages(inputPath, id, options);

  if (results.length === 0) {
    throw new Error('No pages found in PDF');
  }

  if (results.length === 1) {
    const singlePagePath = results[0];
    if (!singlePagePath) {
      throw new Error('Failed to get path for single page conversion');
    }
    if (reencodeSinglePage) {
      await sharp(singlePagePath).png(encode).toFile(outputPath);
    } else {
      await fs.copyFile(singlePagePath, outputPath);
    }
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

  // These buffers are only handed to `composite`, which decodes them again, so their
  // encoding never reaches the caller. Left at level 0 because it is the fastest.
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
    .png(encode)
    .toFile(outputPath);
  }

  if (scale < 1) {
    const scaledPath = outputPath + '.scaled.png';
    const meta = await sharp(outputPath).metadata();
    await sharp(outputPath)
      .resize(Math.round((meta.width || 0) * scale))
      .png(encode)
      .toFile(scaledPath);
    await fs.rename(scaledPath, outputPath);
  }

  return outputPath;
}

/**
 * Same rendering as `convertPdfToPng`, but each page is returned as its own PNG instead of
 * being stitched into one tall image. Nothing calls this unless it asks for it, so the
 * stitched behaviour above is unchanged.
 *
 * Stitching an N-page document produces an image N times taller than one page. Callers that
 * feed the result to an image consumer with its own dimension limits can end up with each
 * page reduced far below the requested scale, so per-page output keeps every page at the
 * size that was actually asked for.
 *
 * Unlike the stitched entry point, this one compresses by default, at
 * PER_PAGE_DEFAULT_COMPRESSION_LEVEL. Pass `compressionLevel` to override it.
 *
 * The returned files live in `temp/` and the caller must delete them.
 */
export async function convertPdfToPngPages(inputPath: string, scale: number = 1.0, options: ConvertPdfToPngOptions = {}): Promise<PdfPageImage[]> {
  const id = randomUUID();
  const encode = pngOptions({
    ...options,
    compressionLevel: options.compressionLevel ?? PER_PAGE_DEFAULT_COMPRESSION_LEVEL,
  });

  await ensureInputAndTempDir(inputPath);

  const rendered = await renderPdfPages(inputPath, id, options);

  if (rendered.length === 0) {
    throw new Error('No pages found in PDF');
  }

  const pages: PdfPageImage[] = [];

  try {
    for (let i = 0; i < rendered.length; i++) {
      const renderedPath = rendered[i];
      if (!renderedPath) {
        throw new Error('Failed to get path for page conversion');
      }

      const outputPath = path.join(TEMP_DIR, `output-${id}-page-${i + 1}.png`);
      const meta = await sharp(renderedPath).metadata();
      const sourceWidth = meta.width || 0;

      if (!sourceWidth) {
        throw new Error('Could not determine image width');
      }

      let pipeline = sharp(renderedPath);
      if (scale < 1) {
        pipeline = pipeline.resize(Math.round(sourceWidth * scale));
      }
      await pipeline.png(encode).toFile(outputPath);
      await fs.unlink(renderedPath).catch(() => undefined);

      const outMeta = await sharp(outputPath).metadata();
      pages.push({
        path: outputPath,
        page: i + 1,
        width: outMeta.width || 0,
        height: outMeta.height || 0,
      });
    }
  } catch (error) {
    // Nothing is returned on failure, so nothing would be left to clean up the pages
    // written so far or the renders not reached yet.
    await Promise.all([
      ...pages.map(page => fs.rm(page.path, { force: true }).catch(() => undefined)),
      ...rendered.map(renderedPath => fs.rm(renderedPath, { force: true }).catch(() => undefined)),
    ]);
    throw error;
  }

  console.log('PDF per-page results:', pages.length, 'pages');
  return pages;
}
