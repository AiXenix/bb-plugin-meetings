import { z } from "zod";

export const summaryTemplateIdSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
export const summaryTemplateInputSchema = z.object({
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(""),
  prompt: z.string().trim().min(1).max(12_000),
}).strict();
export const summaryTemplateSchema = summaryTemplateInputSchema.extend({
  id: summaryTemplateIdSchema,
  badge: z.string().max(50),
  builtIn: z.boolean(),
  editable: z.boolean(),
  updatedAt: z.number().int().nonnegative().nullable(),
});
export type SummaryTemplate = z.infer<typeof summaryTemplateSchema>;
export type SummaryTemplateInput = z.input<typeof summaryTemplateInputSchema>;

export const templateSnapshotSchema = z.object({
  id: summaryTemplateIdSchema,
  label: z.string().min(1).max(120),
  prompt: z.string().min(1).max(12_000),
  systemPrompt: z.string().min(1).max(24_000),
  updatedAt: z.number().int().nonnegative().nullable(),
}).strict();
export type TemplateSnapshot = z.infer<typeof templateSnapshotSchema>;

export const analysisSegmentSchema = z.object({
  id: z.number().int().nonnegative(),
  startSec: z.number().finite().nonnegative(),
  endSec: z.number().finite().nonnegative(),
  speaker: z.string().max(300),
  text: z.string(),
}).refine((s) => s.endSec >= s.startSec, "Segment ends before it starts");
export const analysisDocumentSchema = z.object({
  meetingId: z.string().min(1).max(128),
  title: z.string().max(500),
  segments: z.array(analysisSegmentSchema),
});
export type AnalysisSegment = z.infer<typeof analysisSegmentSchema>;
export type AnalysisDocument = z.infer<typeof analysisDocumentSchema>;

export const analysisContextSchema = z.object({
  totalSegments: z.number().int().nonnegative(),
  includedSegments: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type AnalysisContext = z.infer<typeof analysisContextSchema>;
export const actionItemSchema = z.object({
  id: z.string().min(1).max(100),
  task: z.string().min(1).max(2000),
  assignee: z.string().max(300),
  due: z.string().max(300).nullable(),
  timecodeSec: z.number().finite().nonnegative(),
  done: z.boolean(),
  priority: z.enum(["high", "medium", "low"]),
});
export type ActionItem = z.infer<typeof actionItemSchema>;
export const speakerMetricSchema = z.object({
  speaker: z.string().max(300),
  talkTimeSec: z.number().finite().nonnegative(),
  sharePercent: z.number().finite().min(0).max(100),
  wordCount: z.number().int().nonnegative(),
  wordsPerMin: z.number().finite().nonnegative(),
  segmentCount: z.number().int().nonnegative(),
  questionsAsked: z.number().int().nonnegative(),
});
export type SpeakerMetric = z.infer<typeof speakerMetricSchema>;
export const smartChapterSchema = z.object({
  startSec: z.number().finite().nonnegative(),
  endSec: z.number().finite().nonnegative(),
  title: z.string().min(1).max(300),
  summary: z.string().max(3000),
}).refine((c) => c.endSec >= c.startSec, "Chapter ends before it starts");
export const sentimentSchema = z.object({
  overall: z.enum(["positive", "constructive", "neutral", "tense"]),
  label: z.string().max(300),
  score: z.number().finite().min(0).max(100),
});
// The model supplies this object; provenance and metrics are added by the server.
export const structuredInsightsInputSchema = z.object({
  tldr: z.string().min(1).max(6000),
  decisions: z.array(z.string().min(1).max(2000)).max(50),
  risks: z.array(z.string().min(1).max(2000)).max(50),
  keyTopics: z.array(z.string().min(1).max(300)).max(20),
  sentiment: sentimentSchema,
  chapters: z.array(smartChapterSchema).max(50),
  actionItems: z.array(actionItemSchema.omit({ id: true, done: true }).extend({
    id: z.string().max(100).optional(),
    done: z.boolean().optional(),
  })).max(100),
  followUpDraft: z.string().max(12_000),
});
export const meetingInsightsSchema = structuredInsightsInputSchema.extend({
  template: summaryTemplateIdSchema,
  templateApplied: z.literal(true),
  templateSnapshot: templateSnapshotSchema,
  generatedAt: z.string().datetime(),
  actionItems: z.array(actionItemSchema).max(100),
  speakerMetrics: z.array(speakerMetricSchema).max(500),
  context: analysisContextSchema,
});
export type MeetingInsights = z.infer<typeof meetingInsightsSchema>;
export const meetingAnalysisSchema = z.object({
  meetingId: z.string().min(1).max(128),
  summaryMd: z.string().max(180_000),
  insights: meetingInsightsSchema,
});
export type MeetingAnalysis = z.infer<typeof meetingAnalysisSchema>;

export const askCitationSchema = z.object({
  meetingId: z.string().min(1).max(128),
  meetingTitle: z.string().max(500),
  segmentId: z.number().int().nonnegative(),
  timecodeSec: z.number().finite().nonnegative(),
  speaker: z.string().max(300),
  quote: z.string().min(1).max(2000),
});
export const askResultSchema = z.object({
  answer: z.string().min(1).max(16_000),
  citations: z.array(askCitationSchema).max(50),
  context: analysisContextSchema,
});
export type AskResult = z.infer<typeof askResultSchema>;
