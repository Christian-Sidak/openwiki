import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import { z } from "zod";
import { ClaimSession } from "./session.js";

/**
 * Runtime validator for canonical non-empty identity strings.
 */
const CanonicalNonEmptyStringSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), {
    message: "Must not contain surrounding whitespace",
  });

/**
 * Runtime validator for trimmed non-empty claim prose.
 */
const ClaimStatementSchema = z.string().trim().min(1);

/**
 * Runtime validator for an agent-proposed evidence identity.
 */
const ProposedEvidenceSchema = z
  .object({ resource: CanonicalNonEmptyStringSchema })
  .strict();

/**
 * Runtime validator for one claim operation.
 */
const ClaimOperationSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("add"),
      statement: ClaimStatementSchema,
      evidence: z.array(ProposedEvidenceSchema).min(1),
    })
    .strict(),
  z
    .object({
      op: z.literal("update"),
      id: CanonicalNonEmptyStringSchema,
      statement: ClaimStatementSchema,
      evidence: z.array(ProposedEvidenceSchema).min(1),
    })
    .strict(),
  z
    .object({ op: z.literal("delete"), id: CanonicalNonEmptyStringSchema })
    .strict(),
]);

/**
 * Runtime validator for `update_claims` input.
 */
const UpdateClaimsInputSchema = z
  .object({
    page: CanonicalNonEmptyStringSchema,
    operations: z.array(ClaimOperationSchema).min(1),
  })
  .strict();

/**
 * Runtime validator for `fetch_claims` input.
 */
const FetchClaimsInputSchema = z
  .object({ page: CanonicalNonEmptyStringSchema })
  .strict();

/**
 * Creates the repository-only Claims tools for one run.
 *
 * @param session - Run-scoped authoritative claim state.
 * @returns Mutation and fetch tools bound to the session.
 */
export function createClaimsTools(
  session: ClaimSession,
): StructuredToolInterface[] {
  return [
    new DynamicStructuredTool({
      name: "update_claims",
      description:
        "Atomically add, update, or delete material factual claims for one generated wiki page. Evidence uses repo://path or repo://path#symbol resources. OpenWiki resolves versions and IDs; never supply them.",
      schema: {
        type: "object",
        properties: {
          page: { type: "string", minLength: 1 },
          operations: {
            type: "array",
            minItems: 1,
            items: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    op: { const: "add" },
                    statement: { type: "string", minLength: 1 },
                    evidence: evidenceArraySchema(),
                  },
                  required: ["op", "statement", "evidence"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    op: { const: "update" },
                    id: { type: "string", minLength: 1 },
                    statement: { type: "string", minLength: 1 },
                    evidence: evidenceArraySchema(),
                  },
                  required: ["op", "id", "statement", "evidence"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    op: { const: "delete" },
                    id: { type: "string", minLength: 1 },
                  },
                  required: ["op", "id"],
                  additionalProperties: false,
                },
              ],
            },
          },
        },
        required: ["page", "operations"],
        additionalProperties: false,
      } as const,
      func: async (input) => {
        const parsed = UpdateClaimsInputSchema.parse(input);
        return JSON.stringify(
          await session.updateClaims({
            page: parsed.page,
            operations: parsed.operations,
          }),
          null,
          2,
        );
      },
    }),
    new DynamicStructuredTool({
      name: "fetch_claims",
      description:
        "Fetch the complete current working claim set and revision for one generated wiki page. Call this immediately before writing or deleting that page.",
      schema: {
        type: "object",
        properties: { page: { type: "string", minLength: 1 } },
        required: ["page"],
        additionalProperties: false,
      } as const,
      func: (input) => {
        const parsed = FetchClaimsInputSchema.parse(input);
        return Promise.resolve(
          JSON.stringify(session.fetchClaims(parsed.page), null, 2),
        );
      },
    }),
  ];
}

/**
 * Creates the repeated raw JSON schema for proposed evidence arrays.
 *
 * @returns Strict non-empty evidence-array schema.
 */
function evidenceArraySchema() {
  return {
    type: "array",
    minItems: 1,
    items: {
      type: "object",
      properties: { resource: { type: "string", minLength: 1 } },
      required: ["resource"],
      additionalProperties: false,
    },
  } as const;
}
