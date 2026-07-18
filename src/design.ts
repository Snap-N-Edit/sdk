/**
 * Design-API types for the SDK — a standalone MIRROR of the api's
 * `designSpecSchema` (kept dependency-free: the SDK never imports `zod`/
 * `editor-core` at runtime). The api is the source of truth + validates; these
 * exist purely for caller DX. The compiled `Document` is treated as opaque
 * (`DesignDocument`) — pass it straight to `renderDesign` or the editor.
 *
 * At FULL PARITY with the editor: every layer type + style, multi-page designs,
 * and PDF output are all expressible here.
 */

export type DesignBlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten';

/** A drop shadow effect ({@link DesignLayerEffects}). */
export interface DesignDropShadow {
  color: string;
  blur: number;
  offsetX: number;
  offsetY: number;
  opacity?: number;
}

/** An outer glow effect. */
export interface DesignGlow {
  color: string;
  blur: number;
}

/** Per-layer visual effects — drop shadow / blur / glow. */
export interface DesignLayerEffects {
  shadow?: DesignDropShadow | null;
  blur?: number;
  glow?: DesignGlow | null;
}

export interface DesignLayerBase {
  /** center x in document px */
  x: number;
  /** center y in document px */
  y: number;
  /** degrees, clockwise */
  rotation?: number;
  /** horizontal scale multiplier (negative flips horizontally); default 1 */
  scaleX?: number;
  /** vertical scale multiplier (negative flips vertically); default 1 */
  scaleY?: number;
  opacity?: number;
  blendMode?: DesignBlendMode;
  /** default true; false hides the layer */
  visible?: boolean;
  locked?: boolean;
  name?: string;
  effects?: DesignLayerEffects;
  /** Optional group KEY — layers sharing the same string are grouped (move/select as a unit in the editor). */
  group?: string;
  /** Clip/mask the layer to a shape within its box (rounded rect / ellipse). */
  clip?: { shape: 'rect' | 'ellipse'; radius?: number };
}

/** A styled character range within a text layer (`[start, end)` indices into `text`). */
export interface DesignTextRun {
  start: number;
  end: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  fontFamily?: string;
  fontSize?: number;
}

/** A text drop-shadow (offsets in the text's local pixel units). */
export interface DesignTextShadow {
  color: string;
  blur: number;
  offsetX: number;
  offsetY: number;
}

/** Non-destructive color/tone adjustments; each field is neutral at 0. */
export interface DesignAdjustments {
  brightness?: number;
  contrast?: number;
  saturation?: number;
  exposure?: number;
  temperature?: number;
  tint?: number;
  hue?: number;
}

/** A non-destructive crop/mask in the source image's natural-pixel space. */
export interface DesignCrop {
  shape: 'rect' | 'ellipse';
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The image dropped into a frame — cover-fit, then panned/zoomed. */
export interface DesignFrameFill {
  url: string;
  /** the image's natural pixel width */
  width: number;
  /** the image's natural pixel height */
  height: number;
  /** multiplies the cover-fit scale (default 1) */
  zoom?: number;
  /** pan x in frame-local px (default 0) */
  offsetX?: number;
  /** pan y in frame-local px (default 0) */
  offsetY?: number;
}

export type DesignLayerSpec =
  | (DesignLayerBase & {
      type: 'text';
      text: string;
      fontSize?: number;
      fontFamily?: string;
      color?: string;
      bold?: boolean;
      italic?: boolean;
      align?: 'left' | 'center' | 'right';
      letterSpacing?: number;
      /** Line spacing as a multiple of fontSize (default ~1.2). */
      lineHeight?: number;
      /** A linear gradient filling the text (overrides `color`). */
      fillGradient?: DesignGradientBackground;
      /** Curve the text along an arc, in degrees (0 = straight, + up, - down). */
      curve?: number;
      stroke?: string | null;
      strokeWidth?: number;
      shadow?: DesignTextShadow | null;
      runs?: DesignTextRun[];
      width?: number;
      height?: number;
    })
  | (DesignLayerBase & {
      type: 'image';
      url: string;
      width: number;
      height: number;
      adjustments?: DesignAdjustments;
      crop?: DesignCrop;
    })
  | (DesignLayerBase & {
      type: 'shape';
      shape: 'rect' | 'ellipse' | 'line' | 'triangle' | 'star';
      width: number;
      height: number;
      /** Solid CSS color, a linear gradient, or null for no fill. */
      fill?: string | DesignGradientBackground | null;
      stroke?: string | null;
      strokeWidth?: number;
    })
  | (DesignLayerBase & {
      type: 'element';
      svg: string;
      color?: string;
      /** square box shorthand; ignored if width+height are given */
      size?: number;
      width?: number;
      height?: number;
    })
  | (DesignLayerBase & {
      type: 'frame';
      frameShape?: 'rect' | 'ellipse';
      width: number;
      height: number;
      fill?: DesignFrameFill | null;
    })
  | (DesignLayerBase & {
      type: 'path';
      /** absolute document-space points (≥2); the layer position is derived from these */
      points: { x: number; y: number }[];
      stroke?: string;
      strokeWidth?: number;
      fill?: string | null;
      closed?: boolean;
      /** Render the points as a smooth Bézier curve (pen tool) instead of a polyline. */
      smooth?: boolean;
      /** Explicit per-anchor Bézier control handles (absolute doc-space, index-aligned with points); overrides `smooth`. */
      handles?: { in: { x: number; y: number } | null; out: { x: number; y: number } | null }[];
    });

/** A linear-gradient background: `angle` degrees (0 = left→right, 90 = top→bottom; default 90). */
export interface DesignGradientBackground {
  from: string;
  to: string;
  angle?: number;
}

export interface DesignSpec {
  width: number;
  height: number;
  /** "transparent", a solid CSS color like "#ffffff", or a gradient {from,to,angle}. */
  background?: string | DesignGradientBackground;
  layers?: DesignLayerSpec[];
}

/** A multi-page design — an ordered list of single-page specs (one editor `Document` each). */
export interface MultiPageDesignSpec {
  pages: DesignSpec[];
}

/** The compiled editor document (opaque to the SDK — feed it to `renderDesign` or load it in the editor). */
export type DesignDocument = Record<string, unknown>;

export type RenderFormat = 'png' | 'jpeg' | 'pdf';

/** Input to `renderDesign` — a single spec/document, OR a multi-page `pages`/`documents` (which render to a PDF). */
export interface RenderDesignInput {
  spec?: DesignSpec;
  document?: DesignDocument;
  pages?: DesignSpec[];
  documents?: DesignDocument[];
  /** "png" | "jpeg" for a single page; "pdf" (or any multi-page input) produces a PDF. */
  format?: RenderFormat;
}
