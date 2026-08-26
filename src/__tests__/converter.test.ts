import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { execFileSync } from 'child_process';
import { buildSubstituteFontConfig, convertPdfToPng, convertPdfToPngPages, PdfPageImage } from '../converter';

// This PDF references the standard PDF base-14 fonts (Helvetica / Helvetica-Bold)
// WITHOUT embedding them. On a host with no matching system fonts, poppler renders
// the page graphics but drops all text. The opt-in `substituteFonts` mode supplies
// bundled URW base-35 substitutes so the text renders again.
const NON_EMBEDDED_FONTS_PDF = path.join(__dirname, '../../test-fixtures/non-embedded-fonts.pdf');
const MULTI_PAGE_PDF = path.join(__dirname, '../../test-fixtures/multi-page.pdf');
const SINGLE_PAGE_PDF = path.join(__dirname, '../../test.pdf');

/** Decoded pixels, so two PNGs encoded differently can be compared for equality. */
async function rawPixels(pngPath: string): Promise<Buffer> {
  return sharp(pngPath).raw().toBuffer();
}

async function fileSize(filePath: string): Promise<number> {
  return (await fsp.stat(filePath)).size;
}

async function cleanupPages(pages: PdfPageImage[]): Promise<void> {
  await Promise.all(pages.map(page => cleanup(page.path)));
}

/** Count near-black pixels — a proxy for how much ink (text + graphics) was rendered. */
async function darkPixelCount(pngPath: string): Promise<number> {
  const { data } = await sharp(pngPath).greyscale().raw().toBuffer({ resolveWithObject: true });
  let dark = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i]! < 100) dark++;
  }
  return dark;
}

async function dimensions(pngPath: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(pngPath).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

async function cleanup(pngPath: string): Promise<void> {
  await fsp.rm(pngPath, { force: true }).catch(() => undefined);
}

describe('convertPdfToPng — font substitution (opt-in)', () => {
  it('substituteFonts renders substantially more ink than an empty font dir (deterministic on any host)', async () => {
    // An empty font dir simulates a minimal image with no usable fonts. Because the
    // generated FONTCONFIG_FILE fully REPLACES the host fontconfig, this result does not
    // depend on whatever fonts happen to be installed on the test machine.
    const emptyFontDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pdf2png-empty-fonts-'));

    const blankPath = await convertPdfToPng(NON_EMBEDDED_FONTS_PDF, 1.0, {
      substituteFonts: true,
      fontDir: emptyFontDir,
    });
    const substitutedPath = await convertPdfToPng(NON_EMBEDDED_FONTS_PDF, 1.0, {
      substituteFonts: true,
    });

    try {
      const blankInk = await darkPixelCount(blankPath);
      const substitutedInk = await darkPixelCount(substitutedPath);

      // Text rendering adds a large amount of ink relative to graphics-only output.
      expect(substitutedInk).toBeGreaterThan(blankInk * 1.5);

      // Geometry must be identical — substitution only affects glyphs, not page size.
      expect(await dimensions(substitutedPath)).toEqual(await dimensions(blankPath));
    } finally {
      await cleanup(blankPath);
      await cleanup(substitutedPath);
      await fsp.rm(emptyFontDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('default call (no options) produces a valid PNG of the same dimensions as the opt-in render', async () => {
    const defaultPath = await convertPdfToPng(NON_EMBEDDED_FONTS_PDF);
    const optInPath = await convertPdfToPng(NON_EMBEDDED_FONTS_PDF, 1.0, { substituteFonts: true });

    try {
      const defaultMeta = await sharp(defaultPath).metadata();
      expect(defaultMeta.format).toBe('png');

      // Backward-compat: the new option never changes page geometry.
      expect(await dimensions(defaultPath)).toEqual(await dimensions(optInPath));
    } finally {
      await cleanup(defaultPath);
      await cleanup(optInPath);
    }
  });

  it('substituteFonts: false behaves identically to omitting options', async () => {
    const omitted = await convertPdfToPng(NON_EMBEDDED_FONTS_PDF);
    const explicitFalse = await convertPdfToPng(NON_EMBEDDED_FONTS_PDF, 1.0, { substituteFonts: false });

    try {
      const a = fs.readFileSync(omitted);
      const b = fs.readFileSync(explicitFalse);
      // Same inputs + same (untouched) environment => byte-identical output.
      expect(b.equals(a)).toBe(true);
    } finally {
      await cleanup(omitted);
      await cleanup(explicitFalse);
    }
  });
});

describe('convertPdfToPng — compressionLevel (opt-in)', () => {
  it('omitting compressionLevel is byte-identical to passing 0, the level previous versions used', async () => {
    const omitted = await convertPdfToPng(MULTI_PAGE_PDF);
    const explicitZero = await convertPdfToPng(MULTI_PAGE_PDF, 1.0, { compressionLevel: 0 });

    try {
      expect(fs.readFileSync(explicitZero).equals(fs.readFileSync(omitted))).toBe(true);
    } finally {
      await cleanup(omitted);
      await cleanup(explicitZero);
    }
  });

  it('compressing does not change a single pixel, only the file size', async () => {
    const uncompressed = await convertPdfToPng(MULTI_PAGE_PDF, 1.0, { compressionLevel: 0 });
    const compressed = await convertPdfToPng(MULTI_PAGE_PDF, 1.0, { compressionLevel: 6 });

    try {
      // PNG is lossless at every level, so the decoded rasters must match exactly.
      expect((await rawPixels(compressed)).equals(await rawPixels(uncompressed))).toBe(true);
      expect(await dimensions(compressed)).toEqual(await dimensions(uncompressed));
      expect(await fileSize(compressed)).toBeLessThan(await fileSize(uncompressed));
    } finally {
      await cleanup(uncompressed);
      await cleanup(compressed);
    }
  });

  it('applies to single-page documents too, without changing the pixels', async () => {
    const uncompressed = await convertPdfToPng(SINGLE_PAGE_PDF, 1.0, { compressionLevel: 0 });
    const compressed = await convertPdfToPng(SINGLE_PAGE_PDF, 1.0, { compressionLevel: 6 });

    try {
      expect((await rawPixels(compressed)).equals(await rawPixels(uncompressed))).toBe(true);
      expect(await fileSize(compressed)).toBeLessThan(await fileSize(uncompressed));
    } finally {
      await cleanup(uncompressed);
      await cleanup(compressed);
    }
  });

  it.each([-1, 10, 1.5])('rejects an out-of-range level (%p)', async (level) => {
    await expect(convertPdfToPng(SINGLE_PAGE_PDF, 1.0, { compressionLevel: level })).rejects.toThrow(
      'compressionLevel must be an integer between 0 and 9'
    );
  });
});

describe('convertPdfToPngPages — per-page output (opt-in)', () => {
  it('returns one PNG per page, in page order, each the full size of a page', async () => {
    const stitched = await convertPdfToPng(MULTI_PAGE_PDF);
    let pages: PdfPageImage[] = [];

    try {
      pages = await convertPdfToPngPages(MULTI_PAGE_PDF);
      expect(pages.length).toBeGreaterThan(1);
      expect(pages.map(page => page.page)).toEqual(pages.map((_, index) => index + 1));

      const stitchedSize = await dimensions(stitched);
      // Each page keeps the stitched image's width; the strip is just the pages stacked.
      for (const page of pages) {
        expect(page.width).toBe(stitchedSize.width);
        const meta = await dimensions(page.path);
        expect(meta).toEqual({ width: page.width, height: page.height });
      }
      const summedHeight = pages.reduce((sum, page) => sum + page.height, 0);
      expect(summedHeight).toBe(stitchedSize.height);
    } finally {
      await cleanup(stitched);
      await cleanupPages(pages);
    }
  });

  it('keeps a page at the requested scale, where stitching would make the strip taller instead', async () => {
    let pages: PdfPageImage[] = [];
    let fullSize: PdfPageImage[] = [];

    try {
      fullSize = await convertPdfToPngPages(MULTI_PAGE_PDF, 1.0);
      pages = await convertPdfToPngPages(MULTI_PAGE_PDF, 0.5);

      expect(pages.length).toBe(fullSize.length);
      expect(pages[0]!.width).toBe(Math.round(fullSize[0]!.width * 0.5));
    } finally {
      await cleanupPages(pages);
      await cleanupPages(fullSize);
    }
  });

  it('compresses by default, because every page travels in one response', async () => {
    let defaults: PdfPageImage[] = [];
    let uncompressed: PdfPageImage[] = [];

    try {
      defaults = await convertPdfToPngPages(MULTI_PAGE_PDF);
      uncompressed = await convertPdfToPngPages(MULTI_PAGE_PDF, 1.0, { compressionLevel: 0 });

      expect(await fileSize(defaults[0]!.path)).toBeLessThan(await fileSize(uncompressed[0]!.path));
      // Compression is lossless, so the page itself must be unchanged.
      expect((await rawPixels(defaults[0]!.path)).equals(await rawPixels(uncompressed[0]!.path))).toBe(true);
    } finally {
      await cleanupPages(defaults);
      await cleanupPages(uncompressed);
    }
  });

  it('an explicit compressionLevel overrides the per-page default', async () => {
    let explicitZero: PdfPageImage[] = [];
    let stitchedZero: string | undefined;

    try {
      explicitZero = await convertPdfToPngPages(SINGLE_PAGE_PDF, 1.0, { compressionLevel: 0 });
      stitchedZero = await convertPdfToPng(SINGLE_PAGE_PDF, 1.0, { compressionLevel: 0 });

      // One page, same level, same encoder: the page file matches the stitched file.
      expect(fs.readFileSync(explicitZero[0]!.path).equals(fs.readFileSync(stitchedZero))).toBe(true);
    } finally {
      await cleanupPages(explicitZero);
      if (stitchedZero) await cleanup(stitchedZero);
    }
  });

  it('a single-page PDF comes back as one page', async () => {
    let pages: PdfPageImage[] = [];

    try {
      pages = await convertPdfToPngPages(SINGLE_PAGE_PDF);
      expect(pages.length).toBe(1);
      expect(pages[0]!.page).toBe(1);
    } finally {
      await cleanupPages(pages);
    }
  });

  it('leaves no rendered pages behind in temp beyond the returned files', async () => {
    const before = (await fsp.readdir('temp')).filter(file => file.startsWith('page-'));
    let pages: PdfPageImage[] = [];

    try {
      pages = await convertPdfToPngPages(MULTI_PAGE_PDF);
      const after = (await fsp.readdir('temp')).filter(file => file.startsWith('page-'));
      expect(after).toEqual(before);
    } finally {
      await cleanupPages(pages);
    }
  });
});

// ---------------------------------------------------------------------------------------
// Font FALLBACK — the opt-in `fontFallback` mode, distinct from `substituteFonts` above.
//
// The generated fontconfig file fully replaces the host config, so it also has to supply the
// generic-family fallback layer a full fontconfig installation provides. Without it, a family
// the file does not alias by hand matches nothing and fontconfig returns whatever sorts first
// in the bundled directory, which is D050000L — URW's ZapfDingbats clone. A customer order
// referencing non-embedded ArialNarrow and Tahoma rendered its item lines, quantities and
// dimensions as dingbats; pdftoppm exited 0, and the ink-based test above passed, because
// dingbats are ink too.
//
// The mode is opt-in: with the flag absent the generated file must stay byte-for-byte what
// previous versions wrote, because other programs call this service.
// ---------------------------------------------------------------------------------------

const UNALIASED_FONTS_PDF = path.join(__dirname, '../../test-fixtures/unaliased-non-embedded-fonts.pdf');
const DEFAULT_FONTS_DIR = path.join(__dirname, '../../fonts');
const DINGBATS_FONT_FILE = path.join(DEFAULT_FONTS_DIR, 'D050000L.otf');

/** Which font file the generated config actually resolves a family name to. */
function resolveFamily(confPath: string, family: string): string {
  const out = execFileSync('fc-match', [family], {
    env: { ...process.env, FONTCONFIG_FILE: confPath },
    encoding: 'utf8',
  });
  return out.split(':')[0]!.trim();
}

async function withGeneratedConfig<T>(
  fontFallback: boolean,
  fn: (confPath: string) => Promise<T> | T,
): Promise<T> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pdf2png-fontconf-'));
  const { confPath, cacheDir } = await buildSubstituteFontConfig(tempDir, DEFAULT_FONTS_DIR, 'test', fontFallback);
  try {
    return await fn(confPath);
  } finally {
    await fsp.rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

describe('buildSubstituteFontConfig — default path is unchanged', () => {
  it('emits exactly the aliases previous versions emitted, and nothing else', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pdf2png-fontconf-'));
    const { confPath, cacheDir } = await buildSubstituteFontConfig(tempDir, DEFAULT_FONTS_DIR, 'x');
    try {
      const conf = await fsp.readFile(confPath, 'utf8');
      // The literal file previous versions wrote. Pinned in full on purpose: any edit to the
      // template that reaches the default path has to fail here, loudly, before it can change
      // output for a caller that never opted in.
      const expected = [
        '<?xml version="1.0"?>',
        '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">',
        '<fontconfig>',
        `  <dir>${path.resolve(DEFAULT_FONTS_DIR)}</dir>`,
        `  <cachedir>${cacheDir}</cachedir>`,
        '  <alias binding="same"><family>Helvetica</family><accept><family>Nimbus Sans</family></accept></alias>',
        '  <alias binding="same"><family>Arial</family><accept><family>Nimbus Sans</family></accept></alias>',
        '  <alias binding="same"><family>Times</family><accept><family>Nimbus Roman</family></accept></alias>',
        '  <alias binding="same"><family>Times New Roman</family><accept><family>Nimbus Roman</family></accept></alias>',
        '  <alias binding="same"><family>Courier</family><accept><family>Nimbus Mono PS</family></accept></alias>',
        '  <alias binding="same"><family>Courier New</family><accept><family>Nimbus Mono PS</family></accept></alias>',
        '  <alias binding="same"><family>Symbol</family><accept><family>Standard Symbols PS</family></accept></alias>',
        '  <alias binding="same"><family>ZapfDingbats</family><accept><family>Dingbats</family></accept></alias>',
        '</fontconfig>',
        '',
      ].join('\n');
      expect(conf).toBe(expected);
    } finally {
      await fsp.rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('still resolves an unaliased family to Dingbats, the behaviour existing callers have', async () => {
    await withGeneratedConfig(false, confPath => {
      expect(resolveFamily(confPath, 'ArialNarrow')).toBe('D050000L.otf');
      expect(resolveFamily(confPath, 'Tahoma')).toBe('D050000L.otf');
    });
  });

  it('renders a PDF of unaliased fonts identically with the flag absent and explicitly false', async () => {
    const implicitPath = await convertPdfToPng(UNALIASED_FONTS_PDF, 1.0, { substituteFonts: true });
    const explicitPath = await convertPdfToPng(UNALIASED_FONTS_PDF, 1.0, {
      substituteFonts: true,
      fontFallback: false,
    });
    try {
      expect(Buffer.compare(await rawPixels(implicitPath), await rawPixels(explicitPath))).toBe(0);
    } finally {
      await cleanup(implicitPath);
      await cleanup(explicitPath);
    }
  });
});

describe('buildSubstituteFontConfig — fontFallback: true', () => {
  it('never resolves an unaliased family to the Dingbats face', async () => {
    // Real families seen on incoming customer orders, none of them aliased by name.
    const unaliased = ['ArialNarrow', 'Arial Narrow', 'Tahoma', 'Verdana', 'Calibri', 'Segoe UI', 'Frutiger'];

    await withGeneratedConfig(true, confPath => {
      const resolved = Object.fromEntries(unaliased.map(f => [f, resolveFamily(confPath, f)]));

      for (const file of Object.values(resolved)) {
        expect(file).not.toBe('D050000L.otf');
        // And it must be a real face from the bundled directory, not an empty result.
        expect(file).toMatch(/\.otf$/);
      }

      // A narrow family keeps its width rather than widening to the regular sans.
      expect(resolved['ArialNarrow']).toBe('NimbusSansNarrow-Regular.otf');
      expect(resolved['Arial Narrow']).toBe('NimbusSansNarrow-Regular.otf');
    });
  });

  it('leaves every base-14 mapping, including ZapfDingbats, where it was', async () => {
    const expected: Record<string, string> = {
      Helvetica: 'NimbusSans-Regular.otf',
      Arial: 'NimbusSans-Regular.otf',
      Times: 'NimbusRoman-Regular.otf',
      'Times New Roman': 'NimbusRoman-Regular.otf',
      Courier: 'NimbusMonoPS-Regular.otf',
      'Courier New': 'NimbusMonoPS-Regular.otf',
      Symbol: 'StandardSymbolsPS.otf',
      // A PDF that genuinely asks for dingbats must still get them. The historical alias names
      // a family called "Dingbats", which no bundled font reports; it resolved correctly only
      // via the same accident this mode removes, so the mode re-points it by real family name.
      ZapfDingbats: 'D050000L.otf',
    };

    await withGeneratedConfig(true, confPath => {
      for (const [family, file] of Object.entries(expected)) {
        expect(resolveFamily(confPath, family)).toBe(file);
      }
    });
  });

  it('resolves the generic families the bundled directory does not define itself', async () => {
    await withGeneratedConfig(true, confPath => {
      expect(resolveFamily(confPath, 'sans-serif')).toBe('NimbusSans-Regular.otf');
      expect(resolveFamily(confPath, 'serif')).toBe('NimbusRoman-Regular.otf');
      expect(resolveFamily(confPath, 'monospace')).toBe('NimbusMonoPS-Regular.otf');
    });
  });

  it('renders a PDF of unaliased non-embedded fonts as text, not as dingbats', async () => {
    // Deterministic on any host: both renders read only from bundled fonts. The dingbats-only
    // directory reproduces the default behaviour, where every family falls through to D050000L.
    const dingbatsOnlyDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pdf2png-dingbats-'));
    await fsp.copyFile(DINGBATS_FONT_FILE, path.join(dingbatsOnlyDir, 'D050000L.otf'));

    const dingbatsPath = await convertPdfToPng(UNALIASED_FONTS_PDF, 1.0, {
      substituteFonts: true,
      fontDir: dingbatsOnlyDir,
    });
    const fixedPath = await convertPdfToPng(UNALIASED_FONTS_PDF, 1.0, {
      substituteFonts: true,
      fontFallback: true,
    });

    try {
      // Same page, same geometry — only the glyphs differ.
      expect(await dimensions(fixedPath)).toEqual(await dimensions(dingbatsPath));

      // The two renders must not be the same pixels. If they are, the fallback regressed and
      // the unaliased lines are being drawn with the Dingbats face again.
      expect(Buffer.compare(await rawPixels(fixedPath), await rawPixels(dingbatsPath))).not.toBe(0);

      // Dingbat glyphs are solid symbols and carry markedly more ink than the letters they
      // replaced. Text must therefore be the lighter of the two.
      expect(await darkPixelCount(fixedPath)).toBeLessThan(await darkPixelCount(dingbatsPath));
    } finally {
      await cleanup(dingbatsPath);
      await cleanup(fixedPath);
      await fsp.rm(dingbatsOnlyDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
