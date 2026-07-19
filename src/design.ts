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

export type DesignBlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

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
  /**
   * Raster alpha mask stretched across the layer box: a grayscale PNG `data`:
   * URL (white = visible, black = hidden) with its raster pixel dimensions.
   * Usually PAINTED in the editor rather than authored here.
   */
  mask?: { data: string; width: number; height: number; enabled?: boolean };
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
  /** edge-darkening vignette post-pass, 0 (none) … 1 (strong) */
  vignette?: number;
  /** sharpen/clarity post-pass, 0 (none) … 1 (max) */
  sharpen?: number;
  /** noise-reduction/denoise smoothing post-pass, 0 (none) … 1 (max) */
  denoise?: number;
}

/** A single control point on a tone curve: input `x` → output `y`, both in [0,1]. */
export interface DesignCurvePoint {
  x: number;
  y: number;
}

/** Composite levels for the tone LUT (all fields neutral by absence when the object is omitted). */
export interface DesignLevels {
  /** input black point [0,1], default 0 */
  inBlack: number;
  /** input white point [0,1], default 1 */
  inWhite: number;
  /** midtone gamma (>0), default 1 */
  gamma: number;
  /** output black point [0,1], default 0 */
  outBlack: number;
  /** output white point [0,1], default 1 */
  outWhite: number;
}

/**
 * Curves & Levels — a per-channel value LUT applied after the color matrix.
 * Each curve is a list of {x,y} control points in [0,1] (empty/absent =
 * identity); the composite `rgb` curve is applied to all channels before the
 * per-channel `red`/`green`/`blue` curves. Absent = identity (no-op).
 */
export interface DesignTone {
  /** composite curve applied to all channels */
  rgb?: DesignCurvePoint[];
  red?: DesignCurvePoint[];
  green?: DesignCurvePoint[];
  blue?: DesignCurvePoint[];
  /** composite levels (all channels) */
  levels?: DesignLevels;
}

/** One stop of a gradient map: a CSS hex color at a normalized luminance position [0,1]. */
export interface DesignGradientMapStop {
  color: string;
  /** normalized luminance position, 0 (black) … 1 (white) */
  position: number;
}

/**
 * Gradient map — remaps the image's per-pixel luminance onto a multi-stop
 * gradient (the multi-stop generalization of duotone). Needs ≥2 stops to take
 * effect; absent/degenerate = identity (no-op).
 */
export interface DesignGradientMap {
  stops: DesignGradientMapStop[];
}

/**
 * A local-adjustment REGION, in normalized 0..1 box-UV space (`(0,0)` = box
 * top-left). Either a radial ellipse or a graduated linear ramp.
 */
export type DesignLocalAdjustRegion =
  | {
      type: 'radial';
      /** ellipse center X in UV [0,1] */
      cx: number;
      /** ellipse center Y in UV [0,1] */
      cy: number;
      /** ellipse X radius (fraction of box width) */
      rx: number;
      /** ellipse Y radius (fraction of box height) */
      ry: number;
      /** feather fraction 0..1 (outer band over which coverage ramps 1→0) */
      feather: number;
    }
  | {
      type: 'graduated';
      /** start point X in UV (coverage 0) */
      x1: number;
      /** start point Y in UV */
      y1: number;
      /** end point X in UV (coverage 1) */
      x2: number;
      /** end point Y in UV */
      y2: number;
    };

/** One local/selective adjustment: a region + the adjustments applied within it (composited on top of the whole-image passes). */
export interface DesignLocalAdjustment {
  region: DesignLocalAdjustRegion;
  adjustments: DesignAdjustments;
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
      /** Curves & Levels (per-channel value LUT); absent = identity. */
      tone?: DesignTone;
      /** Gradient map (luminance → multi-stop gradient LUT); absent/<2 stops = identity. */
      gradientMap?: DesignGradientMap;
      /** Local/selective adjustments: {region, adjustments} applied to a region (radial/graduated) rather than the whole image; composited on top in order. */
      localAdjustments?: DesignLocalAdjustment[];
      crop?: DesignCrop;
      /**
       * Manual retouch overlay: a transparent RGBA PNG `data`: URL (+ its pixel
       * size) composited over the image BEFORE adjustments; painted by the
       * editor's clone/heal/dodge-burn/red-eye tools rather than authored.
       */
      retouch?: { data: string; width: number; height: number; enabled?: boolean };
    })
  | (DesignLayerBase & {
      type: 'shape';
      shape: 'rect' | 'ellipse' | 'line' | 'triangle' | 'star' | 'polygon' | 'arrow';
      width: number;
      height: number;
      /** Solid CSS color, a linear gradient, or null for no fill. */
      fill?: string | DesignGradientBackground | null;
      stroke?: string | null;
      strokeWidth?: number;
      /** Vertex count for a "polygon" shape, 3-12 (default 6; ignored by other shapes). */
      sides?: number;
      /** Spike count for a "star" shape, 3-12 (default 5; ignored by other shapes). */
      points?: number;
      /** Inner/outer radius ratio for a "star" shape, 0.2-0.9 (default 0.4; ignored by other shapes). */
      innerRatio?: number;
      /** Arrowhead at the start of a "line" shape (ignored by other shapes). */
      startHead?: 'none' | 'arrow';
      /** Arrowhead at the end of a "line" shape (ignored by other shapes). */
      endHead?: 'none' | 'arrow';
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
