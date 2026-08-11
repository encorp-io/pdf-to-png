import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { convertPdfToPng, convertPdfToPngPages } from './converter';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors());
app.use(express.raw({
  type: ['application/pdf', 'application/octet-stream'],
  limit: '50mb'
}));

app.post('/convert', async (req, res) => {
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  let pagePaths: string[] = [];

  const rawScale = req.query.scale;
  const scale = rawScale !== undefined ? parseFloat(rawScale as string) : 1.0;

  if (isNaN(scale) || scale <= 0 || scale > 1) {
    return res.status(400).json({ error: 'scale must be a number between 0 (exclusive) and 1 (inclusive)' });
  }

  // Opt-in only. Absent param => false => identical behavior to previous versions.
  const substituteFonts = req.query.substituteFonts === 'true';

  // Opt-in only. Absent param => one stitched PNG, exactly as before.
  const perPage = req.query.perPage === 'true';

  // Opt-in only. Absent param => level 0 => byte-identical output to previous versions.
  const rawCompressionLevel = req.query.compressionLevel;
  let compressionLevel: number | undefined;
  if (rawCompressionLevel !== undefined) {
    compressionLevel = Number(rawCompressionLevel);
    if (!Number.isInteger(compressionLevel) || compressionLevel < 0 || compressionLevel > 9) {
      return res.status(400).json({ error: 'compressionLevel must be an integer between 0 and 9' });
    }
  }

  try {
    if (!req.body || !Buffer.isBuffer(req.body)) {
      return res.status(400).json({ error: 'No PDF binary data received' });
    }

    if (req.body.length === 0) {
      return res.status(400).json({ error: 'Uploaded file is empty' });
    }

    console.log('Received binary data:', {
      size: req.body.length,
      contentType: req.get('Content-Type'),
      firstBytes: req.body.subarray(0, 10).toString('hex')
    });

    // Validate PDF header
    if (!req.body.subarray(0, 4).equals(Buffer.from('%PDF'))) {
      return res.status(400).json({ error: 'Invalid PDF file - missing PDF header' });
    }

    // Create temporary input file
    inputPath = path.join('uploads', `input-${randomUUID()}.pdf`);
    await fs.writeFile(inputPath, req.body);

    if (perPage) {
      const pages = await convertPdfToPngPages(inputPath, scale, { substituteFonts, compressionLevel });
      pagePaths = pages.map(page => page.path);

      const encoded = await Promise.all(pages.map(async page => ({
        page: page.page,
        width: page.width,
        height: page.height,
        data: (await fs.readFile(page.path)).toString('base64'),
      })));

      return res.json({ count: encoded.length, pages: encoded });
    }

    outputPath = await convertPdfToPng(inputPath, scale, { substituteFonts, compressionLevel });

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', 'attachment; filename="converted.png"');

    const fileBuffer = await fs.readFile(outputPath);
    res.send(fileBuffer);

  } catch (error) {
    console.error('Conversion error:', error);

    let errorMessage = 'Failed to convert PDF to PNG';
    if (error instanceof Error) {
      if (error.message.includes('No pages found')) {
        errorMessage = 'PDF file appears to be empty or corrupted';
      } else if (error.message.includes('Could not determine')) {
        errorMessage = 'PDF file format is not supported';
      }
    }

    res.status(500).json({ error: errorMessage });
  } finally {
    if (inputPath) {
      try {
        await fs.unlink(inputPath);
      } catch (cleanupError) {
        console.error('Failed to cleanup input file:', cleanupError);
      }
    }

    if (outputPath) {
      try {
        await fs.unlink(outputPath);
      } catch (cleanupError) {
        console.error('Failed to cleanup output file:', cleanupError);
      }
    }

    for (const pagePath of pagePaths) {
      try {
        await fs.unlink(pagePath);
      } catch (cleanupError) {
        console.error('Failed to cleanup page file:', cleanupError);
      }
    }
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

export { app };

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}