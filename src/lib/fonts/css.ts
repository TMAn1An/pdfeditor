import type { FontRef } from '../../types/project';
import type { MeasureFn } from '../text/layout';
import { customFontId, standardFontInfo } from './standard';
import { cssFamilyFor } from './upload';

export interface CssFont {
  family: string;
  weight: 'normal' | 'bold';
  style: 'normal' | 'italic';
}

export function cssFontFor(ref: FontRef, fallback?: FontRef | null): CssFont {
  const std = standardFontInfo(ref);
  const fb = fallback ? cssFontFor(fallback).family : 'sans-serif';
  if (std) return { family: `${std.css}`, weight: std.weight, style: std.style };
  const id = customFontId(ref);
  return { family: `"${cssFamilyFor(id ?? '')}", ${fb}`, weight: 'normal', style: 'normal' };
}

let canvas: HTMLCanvasElement | null = null;

/** Approximate text measurement with the browser's fonts (for on-screen hints only). */
export function canvasMeasure(font: CssFont): MeasureFn {
  canvas ??= document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  return (text, size) => {
    ctx.font = `${font.style} ${font.weight} ${size}px ${font.family}`;
    return ctx.measureText(text).width;
  };
}
