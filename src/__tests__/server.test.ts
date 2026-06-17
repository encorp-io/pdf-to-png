import request from 'supertest';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { app } from '../server';

const SINGLE_PAGE_PDF = path.join(__dirname, '../../test.pdf');
const MULTI_PAGE_PDF = path.join(__dirname, '../../test-fixtures/multi-page.pdf');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function parseBinaryResponse(res: request.Response, callback: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
  res.on('error', callback);
}

async function convertPdf(pdf: string, query = ''): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const res = await (request(app) as ReturnType<typeof request>)
    .post(`/convert${query}`)
    .set('Content-Type', 'application/pdf')
    .buffer(true)
    .parse(parseBinaryResponse)
    .send(fs.readFileSync(pdf));
  return { status: res.status, headers: res.headers as Record<string, string>, body: res.body as Buffer };
}

// ─────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with status OK and a timestamp', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');
    expect(typeof res.body.timestamp).toBe('string');
  });
});

// ─────────────────────────────────────────────
// Input validation
// ─────────────────────────────────────────────

describe('POST /convert — input validation', () => {
  it('returns 400 with { error } when no body is sent', async () => {
    const res = await request(app)
      .post('/convert')
      .set('Content-Type', 'application/pdf');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(typeof res.body.error).toBe('string');
  });

  it('returns 400 with { error } when body is empty', async () => {
    const res = await request(app)
      .post('/convert')
      .set('Content-Type', 'application/pdf')
      .send(Buffer.alloc(0));
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(typeof res.body.error).toBe('string');
  });

  it('returns 400 with { error } when body is not a PDF (missing %PDF header)', async () => {
    const res = await request(app)
      .post('/convert')
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('this is definitely not a pdf'));
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(typeof res.body.error).toBe('string');
  });
});

// ─────────────────────────────────────────────
// Scale parameter validation
// ─────────────────────────────────────────────

describe('POST /convert — scale validation', () => {
  const pdfBuffer = () => fs.readFileSync(SINGLE_PAGE_PDF);

  it('returns 400 when scale=0 (exclusive lower bound)', async () => {
    const res = await request(app).post('/convert?scale=0').set('Content-Type', 'application/pdf').send(pdfBuffer());
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 400 when scale is negative', async () => {
    const res = await request(app).post('/convert?scale=-0.5').set('Content-Type', 'application/pdf').send(pdfBuffer());
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 400 when scale > 1', async () => {
    const res = await request(app).post('/convert?scale=2').set('Content-Type', 'application/pdf').send(pdfBuffer());
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 400 when scale is not a number', async () => {
    const res = await request(app).post('/convert?scale=abc').set('Content-Type', 'application/pdf').send(pdfBuffer());
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 400 when scale is an empty string', async () => {
    const res = await request(app).post('/convert?scale=').set('Content-Type', 'application/pdf').send(pdfBuffer());
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('accepts scale=1 (integer boundary)', async () => {
    const { status } = await convertPdf(SINGLE_PAGE_PDF, '?scale=1');
    expect(status).toBe(200);
  });

  it('accepts scale=1.0 (float boundary)', async () => {
    const { status } = await convertPdf(SINGLE_PAGE_PDF, '?scale=1.0');
    expect(status).toBe(200);
  });
});

// ─────────────────────────────────────────────
// Backward-compatibility contract
// ─────────────────────────────────────────────

describe('POST /convert — backward-compatibility contract', () => {
  it('returns Content-Type: image/png', async () => {
    const { status, headers } = await convertPdf(SINGLE_PAGE_PDF);
    expect(status).toBe(200);
    expect(headers['content-type']).toMatch(/^image\/png/);
  });

  it('returns Content-Disposition: attachment; filename="converted.png"', async () => {
    const { headers } = await convertPdf(SINGLE_PAGE_PDF);
    expect(headers['content-disposition']).toBe('attachment; filename="converted.png"');
  });

  it('response body starts with PNG magic bytes', async () => {
    const { body } = await convertPdf(SINGLE_PAGE_PDF);
    expect(body.subarray(0, 8)).toEqual(PNG_MAGIC);
  });

  it('error responses always have shape { error: string }', async () => {
    const cases = [
      request(app).post('/convert').set('Content-Type', 'application/pdf'),
      request(app).post('/convert?scale=0').set('Content-Type', 'application/pdf').send(fs.readFileSync(SINGLE_PAGE_PDF)),
      request(app).post('/convert?scale=abc').set('Content-Type', 'application/pdf').send(fs.readFileSync(SINGLE_PAGE_PDF)),
    ];
    const responses = await Promise.all(cases);
    for (const res of responses) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body).toHaveProperty('error');
      expect(typeof res.body.error).toBe('string');
    }
  });
});

// ─────────────────────────────────────────────
// Conversion correctness
// ─────────────────────────────────────────────

describe('POST /convert — conversion correctness', () => {
  it('single-page PDF produces a valid PNG', async () => {
    const { status, body } = await convertPdf(SINGLE_PAGE_PDF);
    expect(status).toBe(200);
    const meta = await sharp(body).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
  });

  it('multi-page PDF produces a single stitched PNG taller than a single page', async () => {
    const [single, multi] = await Promise.all([
      convertPdf(SINGLE_PAGE_PDF),
      convertPdf(MULTI_PAGE_PDF),
    ]);
    expect(single.status).toBe(200);
    expect(multi.status).toBe(200);

    const singleMeta = await sharp(single.body).metadata();
    const multiMeta = await sharp(multi.body).metadata();

    expect(multiMeta.format).toBe('png');
    // Stitched image must be taller than a single page
    expect(multiMeta.height!).toBeGreaterThan(singleMeta.height!);
    // Width should be the same (same source document)
    expect(multiMeta.width).toBe(singleMeta.width);
  });

  it('?scale=0.5 produces a PNG with ~half the width of unscaled', async () => {
    const [full, scaled] = await Promise.all([
      convertPdf(SINGLE_PAGE_PDF),
      convertPdf(SINGLE_PAGE_PDF, '?scale=0.5'),
    ]);
    const fullMeta = await sharp(full.body).metadata();
    const scaledMeta = await sharp(scaled.body).metadata();

    const expectedWidth = Math.round(fullMeta.width! * 0.5);
    expect(scaledMeta.width).toBeGreaterThanOrEqual(expectedWidth - 2);
    expect(scaledMeta.width).toBeLessThanOrEqual(expectedWidth + 2);
  });

  it('no scale parameter produces same result as scale=1', async () => {
    const [noScale, scaleOne] = await Promise.all([
      convertPdf(SINGLE_PAGE_PDF),
      convertPdf(SINGLE_PAGE_PDF, '?scale=1'),
    ]);
    const noScaleMeta = await sharp(noScale.body).metadata();
    const scaleOneMeta = await sharp(scaleOne.body).metadata();

    expect(scaleOneMeta.width).toBe(noScaleMeta.width);
    expect(scaleOneMeta.height).toBe(noScaleMeta.height);
  });
});

// ─────────────────────────────────────────────
// Temp file cleanup
// ─────────────────────────────────────────────

describe('POST /convert — temp file cleanup', () => {
  function countFiles(dir: string): number {
    try {
      return fs.readdirSync(dir).length;
    } catch {
      return 0;
    }
  }

  it('cleans up temp and uploads dirs after a successful conversion', async () => {
    const uploadsBefore = countFiles('uploads');
    const tempBefore = countFiles('temp');

    await convertPdf(SINGLE_PAGE_PDF);

    expect(countFiles('uploads')).toBe(uploadsBefore);
    expect(countFiles('temp')).toBe(tempBefore);
  });

  it('cleans up uploads dir after a failed conversion (corrupt PDF)', async () => {
    const uploadsBefore = countFiles('uploads');

    await request(app)
      .post('/convert')
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('%PDF-1.4 this is corrupt'));

    expect(countFiles('uploads')).toBe(uploadsBefore);
  });
});

// ─────────────────────────────────────────────
// Concurrency
// ─────────────────────────────────────────────

describe('POST /convert — concurrency', () => {
  it('handles three simultaneous conversions without interference', async () => {
    const results = await Promise.all([
      convertPdf(SINGLE_PAGE_PDF),
      convertPdf(SINGLE_PAGE_PDF, '?scale=0.5'),
      convertPdf(MULTI_PAGE_PDF),
    ]);

    for (const { status, body } of results) {
      expect(status).toBe(200);
      expect(body.subarray(0, 8)).toEqual(PNG_MAGIC);
    }

    const metas = await Promise.all(results.map(r => sharp(r.body).metadata()));
    const [fullWidth, scaledWidth, multiWidth] = metas.map(m => m.width!);
    // Scaled result must be ~half the width of the full result
    expect(scaledWidth).toBeLessThan(fullWidth!);
    // Multi-page result must be the same width as single-page (same source)
    expect(multiWidth).toBe(fullWidth);
  });
});
