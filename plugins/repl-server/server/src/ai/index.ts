/** Public surface of the AI feature. @module */

export { createAiService } from './service.ts';
export type {
  AiCatalog,
  AiConfigResponse,
  AiConfigWriteResponse,
  AiRunAuditEvent,
  AiService,
  AiServiceDeps,
  AnnotationApplyResponse,
  AnnotationPreviewResponse,
  ProposeResponse,
} from './service.ts';
export { getAiSettings, effectiveAiSettings, DEFAULT_AI_SETTINGS } from './settings.ts';
export type { AiSettings, EffectiveAiSettings } from './settings.ts';
export { AiRunnerError } from './errors.ts';
export { createAiRunner } from './runner.ts';
