/**
 * Design-API types for the SDK — a standalone MIRROR of the api's
 * `designSpecSchema` (kept dependency-free: the SDK never imports `zod`/
 * `editor-core` at runtime). The api is the source of truth + validates; these
 * exist purely for caller DX. The compiled `Document` is treated as opaque
 * (`DesignDocument`) — pass it straight to `renderDesign` or the editor.
 */

export interface DesignLayerBase {
  /** center x in document px */
  x: number;
  /** center y in document px */
  y: number;
  /** degrees, clockwise */
  rotation?: number;
  opacity?: number;
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
    })
  | (DesignLayerBase & { type: 'image'; url: string; width: number; height: number })
  | (DesignLayerBase & {
      type: 'shape';
      shape: 'rect' | 'ellipse' | 'line' | 'triangle' | 'star';
      width: number;
      height: number;
      fill?: string | null;
      stroke?: string | null;
      strokeWidth?: number;
    })
  | (DesignLayerBase & { type: 'element'; svg: string; color?: string; size?: number });

export interface DesignSpec {
  width: number;
  height: number;
  /** "transparent" or a solid CSS color like "#ffffff". */
  background?: string;
  layers?: DesignLayerSpec[];
}

/** The compiled editor document (opaque to the SDK — feed it to `renderDesign` or load it in the editor). */
export type DesignDocument = Record<string, unknown>;

export type RenderFormat = 'png' | 'jpeg';
