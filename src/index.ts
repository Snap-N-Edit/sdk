export { isStorageDestinationView } from './client.js';
export type { StorageDestinationRow } from './client.js';
export { createClient } from './client.js';
export type {
  BinaryInput,
  CreateClientOptions,
  CreateJobOptions,
  CreateJobResult,
  DestinationTestResult,
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
export type {
  JobDelivery,
  JobDeliveryStatus,
  JobDestination,
  JobDestinationSummary,
  JobInputKind,
} from '@snapnedit/shared/jobRequest';

/**
 * The SAVED STORAGE DESTINATION wire types — the shapes
 * `listDestinations()` / `createDestination()` / `updateDestination()` /
 * `presignDestinationUpload()` speak. Same rule: `import type` only, straight
 * from the shared subpath, so the SDK and the api cannot describe a
 * destination differently.
 */
export type {
  DestinationExportExt,
  DestinationPresignRequest,
  DestinationPresignResponse,
  StorageDestinationInput,
  StorageDestinationPatchInput,
  StorageDestinationSummary,
  StorageDestinationTest,
  StorageDestinationView,
  StorageProvider,
} from '@snapnedit/shared/jobRequest';

/** The job-status union, including the `download: null` (delete-after-delivery) variant. */
export type { JobStatus, JobStatusDelivered, JobStatusResponse, SignedUrl } from '@snapnedit/shared';

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
