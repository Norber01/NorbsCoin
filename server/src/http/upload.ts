import busboy from 'busboy';
import type { NextFunction, Request, Response } from 'express';
import { badRequest } from '../lib/errors.js';

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  size: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      upload?: UploadedFile;
    }
  }
}

/**
 * Parses a multipart form with at most one file into memory (req.upload, req.body).
 * Works both on a plain Node server (streams the request) and on Cloud Functions,
 * where the platform has already read the body into req.rawBody.
 */
export function singleFileUpload(field: string, maxBytes: number) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.is('multipart/form-data')) return next(badRequest('invalid_upload', 'Expected a file upload.'));
    let bb: busboy.Busboy;
    try {
      bb = busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: 1, fields: 10, fieldSize: 1024 } });
    } catch {
      return next(badRequest('invalid_upload', 'Invalid upload.'));
    }
    const fields: Record<string, string> = {};
    let file: UploadedFile | undefined;
    let error: Error | undefined;
    let pending = 0;
    let finished = false;
    const done = () => {
      if (!finished || pending > 0) return;
      if (error) return next(error);
      req.body = fields;
      req.upload = file;
      next();
    };

    bb.on('field', (name, value) => {
      fields[name] = value;
    });
    bb.on('file', (name, stream, info) => {
      if (name !== field) {
        stream.resume();
        return;
      }
      pending++;
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('limit', () => {
        error = badRequest('file_too_large', `The file must be ${Math.floor(maxBytes / 1024 / 1024)} MB or smaller.`);
      });
      stream.on('end', () => {
        const buffer = Buffer.concat(chunks);
        file = { buffer, originalname: info.filename ?? 'upload', size: buffer.length };
        pending--;
        done();
      });
    });
    bb.on('filesLimit', () => {
      error = badRequest('invalid_upload', 'Only one file can be uploaded.');
    });
    bb.on('error', () => {
      error = badRequest('invalid_upload', 'Invalid upload.');
      finished = true;
      done();
    });
    bb.on('close', () => {
      finished = true;
      done();
    });

    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (raw) bb.end(raw);
    else req.pipe(bb);
  };
}
