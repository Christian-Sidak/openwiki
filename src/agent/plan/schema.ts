import { z } from "zod";

/**
 * One planned section, as the model proposes it.
 */
export const SectionPlanSchema = z.object({
  path: z
    .string()
    .regex(/^[\w.-]+(\/[\w.-]+)*\/$/)
    .describe(
      'Wiki-relative section directory with trailing slash, e.g. "architecture/"',
    ),
  brief: z
    .string()
    .min(1)
    .max(300)
    .describe("One line: what this section covers and for whom"),
  sources: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      'Repo-relative globs this section documents, e.g. "src/billing/**"',
    ),
});

/**
 * Full plan: the section list for a repo.
 */
export const PlanSchema = z.object({
  sections: z.array(SectionPlanSchema).min(1).max(12),
});

/**
 * Planner decision for paths no section claims.
 */
export const UnclaimedDecisionSchema = z.object({
  extend: z
    .array(
      z.object({
        path: z.string().describe("Existing section path to widen"),
        addSources: z.array(z.string().min(1)).min(1),
      }),
    )
    .describe("Paths that belong to existing sections"),
  add: z
    .array(SectionPlanSchema)
    .describe("Brand-new sections for genuinely new domains"),
});

/**
 * One planned section, inferred from its schema.
 */
export type SectionPlan = z.infer<typeof SectionPlanSchema>;

/**
 * A full section plan for a repo, inferred from its schema.
 */
export type Plan = z.infer<typeof PlanSchema>;

/**
 * A planner decision over unclaimed paths, inferred from its schema.
 */
export type UnclaimedDecision = z.infer<typeof UnclaimedDecisionSchema>;
