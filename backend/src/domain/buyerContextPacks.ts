import { z } from "zod";

export const buyerContextMaterialDeliveryModes = [
  "summary_only",
  "platform_artifacts",
  "external_links",
  "mixed",
  "withheld_only"
] as const;

export const buyerContextExternalLinkSchema = z.object({
  url: z.string().url(),
  summary: z.string().trim().default("")
});

const obviousStructuredMaterialPattern =
  /\b(attached|uploaded|included|download link|see link|reference image|source file|zip bundle|shared drive|google drive|dropbox|figma|pdf)\b|图片|照片|原图|参考图|附件|压缩包|源文件|下载链接|下载地址|素材|视频|音频/i;

export function buyerContextPackHasMissingStructuredMaterials(value: {
  share_summary: string;
  material_delivery_mode: (typeof buyerContextMaterialDeliveryModes)[number];
  artifact_ids: string[];
  external_context_links: Array<{ url: string; summary: string }>;
  withheld_items: string[];
}) {
  return (
    value.material_delivery_mode === "summary_only" &&
    value.artifact_ids.length === 0 &&
    value.external_context_links.length === 0 &&
    value.withheld_items.length === 0 &&
    obviousStructuredMaterialPattern.test(value.share_summary)
  );
}

export const buyerContextPackSchema = z
  .object({
    owner_confirmed: z.literal(true),
    share_summary: z.string().trim().min(1),
    material_delivery_mode: z.enum(buyerContextMaterialDeliveryModes).default("summary_only"),
    artifact_ids: z.array(z.string().uuid()).default([]),
    external_context_links: z.array(buyerContextExternalLinkSchema).default([]),
    withheld_items: z.array(z.string().trim().min(1)).default([])
  })
  .superRefine((value, ctx) => {
    if (value.material_delivery_mode === "platform_artifacts" && value.artifact_ids.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifact_ids"],
        message: "platform_artifacts mode requires artifact_ids"
      });
    }

    if (value.material_delivery_mode === "external_links" && value.external_context_links.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["external_context_links"],
        message: "external_links mode requires external_context_links"
      });
    }

    if (
      value.material_delivery_mode === "mixed" &&
      value.artifact_ids.length === 0 &&
      value.external_context_links.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["material_delivery_mode"],
        message: "mixed mode requires artifact_ids or external_context_links"
      });
    }

    if (value.material_delivery_mode === "withheld_only" && value.withheld_items.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["withheld_items"],
        message: "withheld_only mode requires withheld_items"
      });
    }

    if (buyerContextPackHasMissingStructuredMaterials(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["share_summary"],
        message: "summary_only mode cannot claim files, images, or links without structured references"
      });
    }
  });

export type BuyerContextPack = z.infer<typeof buyerContextPackSchema>;

export function normalizeBuyerContextPack(value: unknown): BuyerContextPack | null {
  const parsed = buyerContextPackSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function extractLatestBuyerContextPack(
  events: Array<{ event_type?: unknown; payload_json?: unknown }>
) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.event_type !== "buyer_context_submitted") {
      continue;
    }

    const pack = normalizeBuyerContextPack(event.payload_json);
    if (pack) {
      return pack;
    }
  }

  return null;
}
