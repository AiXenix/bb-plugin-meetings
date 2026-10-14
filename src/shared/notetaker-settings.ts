import { z } from "zod";

/** Explicit write allowlist; secrets are accepted here and never returned by settings reads. */
export const notetakerSettingsPatchSchema = z.object({
  botName: z.string().trim().min(1).max(64),
  showAvatar: z.boolean(),
  avatarStyle: z.enum(["initials", "circle", "rounded"]),
  avatarColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  avatarText: z.string().max(12),
  maxDurationMinutes: z.number().int().min(5).max(1440),
  aloneTimeoutMinutes: z.number().min(0.5).max(60),
  waitingTimeoutMinutes: z.number().min(1).max(240),
  silenceTimeoutMinutes: z.number().min(0).max(240),
  maxConcurrentBots: z.number().int().min(1).max(8),
  chatAnnouncement: z.string().max(1000),
  notifyThread: z.boolean(),
  liveTranscription: z.boolean(),
  autoTranscribe: z.boolean(),
  autoSummarize: z.boolean(),
  summaryMode: z.enum(["agent", "api"]),
  summaryTemplateId: z.string().trim().min(1).max(100),
  aiBaseUrl: z.string().max(2048),
  aiModel: z.string().max(200),
  aiApiKey: z.string().max(2000),
  webhookUrl: z.string().max(2048),
  webhookSecret: z.string().max(2000),
  diarization: z.enum(["ui+acoustic", "ui", "acoustic"]),
  speakerLagMs: z.number().int().min(0).max(5000),
  keepRawAudio: z.boolean(),
  gigaamUrl: z.string().max(2048),
  chromePath: z.string().max(2048),
  speakerSelectors: z.string().max(20_000),
  autoSummaryPrompt: z.string().max(4000),
  screenshotIntervalSec: z.number().int().min(0).max(300),
  useZoomAccount: z.boolean(),
  useMeetAccount: z.boolean(),
  useTelemostAccount: z.boolean(),
  calendarAutoJoin: z.boolean(),
  calendarIcsUrls: z.string().max(20_000),
  calendarLeadMinutes: z.number().min(0).max(30),
  calendarOvertimeMinutes: z.number().int().min(0).max(600),
  calendarFilter: z.string().max(500),
  calendarSyncMinutes: z.number().int().min(1).max(120),
}).partial().strict();

export type NotetakerSettingsPatch = z.infer<typeof notetakerSettingsPatchSchema>;

export const notetakerSettingsViewSchema = notetakerSettingsPatchSchema
  .omit({ aiApiKey: true, webhookSecret: true, calendarIcsUrls: true }).required()
  .extend({
    aiApiKeyConfigured: z.boolean(),
    webhookSecretConfigured: z.boolean(),
    calendarIcsUrlsConfigured: z.boolean(),
    calendarFeedCount: z.number().int(),
  });
export type NotetakerSettingsView = z.infer<typeof notetakerSettingsViewSchema>;

export const accountPlatformSchema = z.enum(["zoom", "meet", "telemost"]);
export const browserAccountSchema = z.object({
  platform: accountPlatformSchema,
  enabled: z.boolean(),
  profile: z.object({ exists: z.boolean(), signedIn: z.boolean(), updatedAt: z.number().nullable() }),
  session: z.object({ id: z.string(), phase: z.string(), detail: z.string(), error: z.string().nullable() }).nullable(),
});
export type BrowserAccountView = z.infer<typeof browserAccountSchema>;

export const agentTokenStatusSchema = z.object({ configured: z.boolean(), createdAt: z.number().nullable() });
export const agentMetaSchema = z.object({
  mcpPath: z.string(), apiPath: z.string(),
  personalMcpPath: z.string(), personalApiPath: z.string(),
  webhookHeader: z.string(), webhookAlgorithm: z.string(),
  tools: z.array(z.string()),
  stdio: z.object({ launcher: z.string(), command: z.string(), requiresBbAccess: z.boolean() }).optional(),
  httpRequiresBbConnectAuth: z.boolean().optional(),
});
