import { z } from "zod";

export const signupRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10, "Password must be at least 10 characters"),
  name: z.string().min(1).max(200),
  organizationName: z.string().min(1).max(200),
});
export type SignupRequest = z.infer<typeof signupRequestSchema>;

export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const sessionResponseSchema = z.object({
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    name: z.string().nullable(),
  }),
  organizations: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      slug: z.string(),
      role: z.enum(["OWNER", "ADMIN", "MEMBER", "GUEST"]),
    }),
  ),
  activeOrganizationId: z.string().uuid().nullable(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
