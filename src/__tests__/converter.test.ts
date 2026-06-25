import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { convertPdfToPng } from '../converter';

// This PDF references the standard PDF base-14 fonts (Helvetica / Helvetica-Bold)
// WITHOUT embedding them. On a host with no matching system fonts, poppler renders
// the page graphics but drops all text. The opt-in `substituteFonts` mode supplies
// bundled URW base-35 substitutes so the text renders again.
const NON_EMBEDDED_FONTS_PDF = path.join(__dirname, '../../test-fixtures/non-embedded-fonts.pdf');

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
