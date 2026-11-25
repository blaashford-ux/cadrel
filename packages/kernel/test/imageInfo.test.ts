import { describe, expect, it } from 'vitest';
import { imageInfo } from '../src';

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >> 8) & 255, n & 255];
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));

const png = (w: number, h: number, type = 2, dpi?: number) =>
  Uint8Array.from([0x89, ...text('PNG'), 13, 10, 26, 10, ...be32(13), ...text('IHDR'), ...be32(w), ...be32(h), 8, type, 0, 0, 0, 0, 0, 0, 0, ...(dpi ? [...be32(9), ...text('pHYs'), ...be32(Math.round(dpi / 0.0254)), ...be32(Math.round(dpi / 0.0254)), 1, 0, 0, 0, 0] : []), ...be32(0), ...text('IDAT')]);
const jpeg = (w: number, h: number, comps = 3, dpi?: number) =>
  Uint8Array.from([0xff, 0xd8, ...(dpi ? [0xff, 0xe0, ...be16(16), ...text('JFIF'), 0, 1, 1, 1, ...be16(dpi), ...be16(dpi), 0, 0] : []), 0xff, 0xc0, ...be16(8 + comps * 3), 8, ...be16(h), ...be16(w), comps, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

describe('imageInfo: what a file says about itself, without decoding it', () => {
  it('PNG: size, colour model and declared resolution', () => {
    expect(imageInfo(png(1600, 2560, 2, 300))).toMatchObject({ format: 'png', width: 1600, height: 2560, colour: 'rgb', dpi: 300 });
    expect(imageInfo(png(10, 20, 0))).toMatchObject({ colour: 'grey', dpi: null });
    expect(imageInfo(png(10, 20, 3))).toMatchObject({ colour: 'indexed' });
  });
  it('JPEG: size from the frame header (after other segments), components for the colour model, JFIF density', () => {
    expect(imageInfo(jpeg(1600, 2560, 3, 300))).toMatchObject({ format: 'jpeg', width: 1600, height: 2560, colour: 'rgb', dpi: 300 });
    expect(imageInfo(jpeg(800, 1200, 4))).toMatchObject({ colour: 'cmyk', dpi: null });
    expect(imageInfo(jpeg(800, 1200, 1))).toMatchObject({ colour: 'grey' });
  });
  it('GIF, WebP, PSD, TIFF and SVG', () => {
    expect(imageInfo(Uint8Array.from([...text('GIF89a'), 64, 0, 32, 0, 0, 0]))).toMatchObject({ format: 'gif', width: 64, height: 32 });
    const vp8x = Uint8Array.from([...text('RIFF'), 0, 0, 0, 0, ...text('WEBP'), ...text('VP8X'), 10, 0, 0, 0, 0, 0, 0, 0, 0x1f, 0x03, 0, 0xff, 0x00, 0, 0, 0, 0, 0]);
    expect(imageInfo(vp8x)).toMatchObject({ format: 'webp', width: 800, height: 256 });
    const psd = Uint8Array.from([...text('8BPS'), 0, 1, 0, 0, 0, 0, 0, 0, 0, 3, ...be32(2560), ...be32(1600), 0, 8, 0, 3]);
    expect(imageInfo(psd)).toMatchObject({ format: 'psd', width: 1600, height: 2560, colour: 'rgb' });
    const tiff = Uint8Array.from([...text('MM'), 0, 42, 0, 0, 0, 8, 0, 3, 1, 0, 0, 4, 0, 0, 0, 1, 0, 0, 0x03, 0xe8, 1, 1, 0, 4, 0, 0, 0, 1, 0, 0, 0x07, 0xd0, 1, 6, 0, 3, 0, 0, 0, 1, 0, 2, 0, 0, 0, 0, 0, 0]);
    expect(imageInfo(tiff)).toMatchObject({ format: 'tiff', width: 1000, height: 2000 });
    expect(imageInfo(new TextEncoder().encode('<svg xmlns="x" width="300" height="400"></svg>'))).toMatchObject({ format: 'svg', width: 300, height: 400 });
  });
  it('anything else, or a cut-short header, is not an image', () => {
    expect(imageInfo(new Uint8Array(0))).toBeNull();
    expect(imageInfo(new TextEncoder().encode('hello there, this is text'))).toBeNull();
    expect(imageInfo(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0, 4, 0, 0]))).toBeNull();
    expect(imageInfo(png(1, 1).subarray(0, 20))).toBeNull();
  });
});
