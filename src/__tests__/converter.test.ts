import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { convertPdfToPng, convertPdfToPngPages, PdfPageImage } from '../converter';

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
