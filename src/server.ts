import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { convertPdfToPng } from './converter';

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

  const rawScale = req.query.scale;
  const scale = rawScale !== undefined ? parseFloat(rawScale as string) : 1.0;

  if (isNaN(scale) || scale <= 0 || scale > 1) {
    return res.status(400).json({ error: 'scale must be a number between 0 (exclusive) and 1 (inclusive)' });
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

    outputPath = await convertPdfToPng(inputPath, scale);

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