export { createClient } from './client.js';
export type {
  BinaryInput,
  CreateClientOptions,
  CreateJobOptions,
  CreateJobResult,
  FetchLike,
  JobEnvelope,
  JobInputRef,
  JobUrlInput,
  JobView,
  RunDeliveredResult,
  RunDownloadedResult,
  RunOptions,
  RunResult,
  SnapneditClient,
  UploadResult,
} from './client.js';

/**
 * The bring-your-own-storage wire types, re-exported so a consumer can name
 * a `destination` (or a `delivery` outcome) without depending on
 * `@snapnedit/shared` themselves. Type-only — see `client.ts`'s module doc.
 */
export type { JobDelivery, JobDeliveryStatus, JobDestination, JobInputKind } from '@snapnedit/shared/jobRequest';

export { KNOWN_ERROR_CODES, SnapneditApiError, SnapneditTimeoutError } from './errors.js';

export {
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_DELIVERY_HEADER,
} from './webhooks.js';
export type {
  WebhookEventType,
  WebhookEventData,
  WebhookDeliveryBody,
  WebhookJobEnvelope,
  VerifyWebhookOptions,
} from './webhooks.js';

export type {
  DesignSpec,
  DesignLayerSpec,
  DesignLayerBase,
  DesignBlendMode,
  DesignDropShadow,
  DesignGlow,
  DesignLayerEffects,
  DesignTextRun,
  DesignTextShadow,
  DesignAdjustments,
  DesignCurvePoint,
  DesignLevels,
  DesignTone,
  DesignGradientMapStop,
  DesignGradientMap,
  DesignLocalAdjustRegion,
  DesignLocalAdjustment,
  DesignCrop,
  DesignFrameFill,
  MultiPageDesignSpec,
  DesignDocument,
  RenderFormat,
  RenderDesignInput,
} from './design.js';
