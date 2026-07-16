export { createClient } from './client.js';
export type {
  BinaryInput,
  CreateClientOptions,
  CreateJobResult,
  FetchLike,
  RunOptions,
  RunResult,
  SnapneditClient,
  UploadResult,
} from './client.js';

export { SnapneditApiError, SnapneditTimeoutError } from './errors.js';

export type {
  DesignSpec,
  DesignLayerSpec,
  DesignLayerBase,
  DesignBlendMode,
  DesignTextRun,
  DesignTextShadow,
  DesignAdjustments,
  DesignCrop,
  DesignFrameFill,
  MultiPageDesignSpec,
  DesignDocument,
  RenderFormat,
  RenderDesignInput,
} from './design.js';
