import { describe, expect, it } from 'vitest';
import {
  RESERVED_SEGMENTS,
  contentDisposition,
  guessContentType,
  hashProblem,
  isValidHash,
  randomHash,
  sanitizeFilename,
  parseDuration,
  parseTimestamp,
  assetKind,
  isActiveContent,
  normalizeTags,
  serializeTags,
  decodeTags,
} from '../src/util';
import { parseRange } from '../src/assets';

describe('hashes', () => {
  it('generates 128-bit, URL-safe, non-colliding hashes', () => {
    const hashes = new Set(Array.from({ length: 500 }, () => randomHash()));
    expect(hashes.size).toBe(500);
    for (const hash of hashes) {
      expect(hash).toHaveLength(22);
      expect(isValidHash(hash)).toBe(true);
    }
  });

  it('rejects short and non-alphabet hashes', () => {
    expect(hashProblem('short')).toMatch(/characters/);
    expect(hashProblem('a'.repeat(65))).toMatch(/characters/);
    expect(hashProblem('has space here!!')).toMatch(/characters/);
    expect(hashProblem('AbcDef1234567890_-')).toBeNull();
  });

  it('keeps reserved service paths out of the hash space', () => {
    for (const reserved of RESERVED_SEGMENTS) {
      expect(isValidHash(reserved)).toBe(false);
    }
  });

  it('spreads generated characters without obvious bias', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 400; i += 1) {
      for (const char of randomHash(58)) counts.set(char, (counts.get(char) ?? 0) + 1);
    }
    expect(counts.size).toBe(58);
    const values = [...counts.values()];
    expect(Math.max(...values) / Math.min(...values)).toBeLessThan(1.6);
  });
});

describe('durations and timestamps', () => {
  it('reads the shorthand agents and humans actually type', () => {
    expect(parseDuration('7d')).toBe(604800);
    expect(parseDuration('12h')).toBe(43200);
    expect(parseDuration('90')).toBe(90);
    expect(parseDuration('2w')).toBe(1209600);
    expect(parseDuration('never')).toBeNull();
    expect(parseDuration('0')).toBeNull();
    expect(parseDuration(null)).toBeNull();
    expect(() => parseDuration('soon')).toThrowError(/duration/);
  });

  it('accepts ISO strings and both epoch shapes', () => {
    expect(parseTimestamp('2026-01-02T03:04:05Z')).toBe(Date.parse('2026-01-02T03:04:05Z'));
    expect(parseTimestamp('1767323045')).toBe(1767323045000);
    expect(parseTimestamp('1767323045000')).toBe(1767323045000);
    expect(parseTimestamp('never')).toBeNull();
    expect(() => parseTimestamp('yesterday')).toThrowError(/timestamp/);
  });
});

describe('filenames', () => {
  it('strips path traversal, control characters and header breakers', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('a\r\nX-Injected: 1.txt')).toBe('aX-Injected: 1.txt'.replace(':', '_'));
    expect(sanitizeFilename('"quoted".png')).toBe('quoted.png');
    expect(sanitizeFilename('')).toBe('download');
    expect(sanitizeFilename('x'.repeat(400))).toHaveLength(200);
    expect(sanitizeFilename('/tmp/dir/report final.pdf')).toBe('report final.pdf');
  });

  it('encodes non-ASCII names in both places a client may look', () => {
    const header = contentDisposition('下载 文件.pdf', 'attachment');
    expect(header).toContain('attachment;');
    expect(header).toContain('filename*=UTF-8\'\'%E4%B8%8B%E8%BD%BD%20%E6%96%87%E4%BB%B6.pdf');
    expect(header).not.toMatch(/[\r\n]/);
  });

  it('falls back to the extension when no content type is given', () => {
    expect(guessContentType('clip.mp4')).toBe('video/mp4');
    expect(guessContentType('clip.mp4', 'audio/mpeg')).toBe('audio/mpeg');
    expect(guessContentType('blob', 'application/octet-stream')).toBe('application/octet-stream');
    expect(assetKind('video/mp4')).toBe('video');
    expect(assetKind('application/zip')).toBe('archive');
  });

  it('treats markup and script types as active content, including parameters', () => {
    expect(isActiveContent('text/html; charset=utf-8')).toBe(true);
    expect(isActiveContent('image/svg+xml')).toBe(true);
    expect(isActiveContent('application/xhtml+xml')).toBe(true);
    expect(isActiveContent('text/javascript')).toBe(true);
    expect(isActiveContent('application/xml')).toBe(true);
    expect(isActiveContent('text/plain')).toBe(false);
    expect(isActiveContent('image/png')).toBe(false);
  });

  it('normalizes tag lists from commas and arrays', () => {
    expect(normalizeTags('课件, PDF， 课件')).toEqual(['课件', 'PDF']);
    expect(normalizeTags(['a', ' a ', '', 'b'])).toEqual(['a', 'b']);
    expect(serializeTags(['a', 'b'])).toBe('["a","b"]');
    expect(serializeTags([])).toBeNull();
    expect(decodeTags('["课件","PDF"]')).toEqual(['课件', 'PDF']);
    expect(decodeTags(null)).toEqual([]);
    expect(() => normalizeTags('x'.repeat(41))).toThrowError(/40/);
  });
});

describe('range parsing', () => {
  it('handles the shapes browsers send, and ignores the rest', () => {
    expect(parseRange('bytes=0-4', 100)).toEqual({ offset: 0, length: 5 });
    expect(parseRange('bytes=90-', 100)).toEqual({ offset: 90, length: 10 });
    expect(parseRange('bytes=-10', 100)).toEqual({ offset: 90, length: 10 });
    expect(parseRange('bytes=0-999', 100)).toEqual({ offset: 0, length: 100 });
    expect(parseRange('bytes=100-', 100)).toBeNull();
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange('bytes=abc', 100)).toBeNull();
  });
});
