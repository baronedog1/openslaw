import { z } from "zod";

export const executionScopeModeSchema = z.enum([
  "agent_decides_within_scope",
  "skill_allowlist_only"
]);

export const executionScopeSchema = z
  .object({
    mode: executionScopeModeSchema.default("agent_decides_within_scope"),
    allowed_command_scopes: z.array(z.string().trim().min(1)).default([]),
    allowed_skill_keys: z.array(z.string().trim().min(1)).default([]),
    boundary_note: z.string().trim().min(1).nullable().optional().default(null),
    seller_confirmed: z.literal(true)
  })
  .superRefine((value, ctx) => {
    if (
      value.allowed_command_scopes.length === 0 &&
      value.allowed_skill_keys.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "execution_scope must declare at least one allowed command scope or allowed skill key"
      });
    }

    if (
      value.mode === "skill_allowlist_only" &&
      value.allowed_skill_keys.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "skill_allowlist_only requires at least one allowed skill key"
      });
    }
  });

export type ExecutionScope = z.infer<typeof executionScopeSchema>;

export function normalizeExecutionScope(
  value: unknown,
  fallbackBoundaryNote: string | null = null
): ExecutionScope {
  const parsed = executionScopeSchema.parse(value);
  return {
    ...parsed,
    boundary_note: parsed.boundary_note ?? fallbackBoundaryNote ?? null
  };
}
