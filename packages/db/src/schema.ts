import {
  integer,
  pgEnum,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const severityEnum = pgEnum("severity", ["low", "medium", "high"]);
export const roleEnum = pgEnum("role", ["owner", "admin", "member"]);

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// `slug` is the subdomain: acme -> acme.<app-domain>.
export const teams = pgTable("teams", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  githubOrg: text("github_org"),
  createdAt: createdAt(),
});

// One team per user; teamId is null until the user creates or joins one.
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  githubId: integer("github_id").notNull().unique(),
  login: text("login").notNull(),
  name: text("name"),
  email: text("email"),
  avatarUrl: text("avatar_url"),
  teamId: integer("team_id").references(() => teams.id, {
    onDelete: "set null",
  }),
  role: roleEnum("role").notNull().default("member"),
  createdAt: createdAt(),
});

export const repos = pgTable(
  "repos",
  {
    id: serial("id").primaryKey(),
    teamId: integer("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("repos_team_owner_name_idx").on(t.teamId, t.owner, t.name)],
);

export const reviews = pgTable("reviews", {
  id: serial("id").primaryKey(),
  repoId: integer("repo_id")
    .notNull()
    .references(() => repos.id, { onDelete: "cascade" }),
  prNumber: integer("pr_number").notNull(),
  headSha: text("head_sha").notNull(),
  agents: text("agents").array().notNull(),
  summary: text("summary").notNull(),
  createdAt: createdAt(),
});

// Mirrors reviewFindingSchema in @pr-review/schemas; keep the two in step.
export const findings = pgTable("findings", {
  id: serial("id").primaryKey(),
  reviewId: integer("review_id")
    .notNull()
    .references(() => reviews.id, { onDelete: "cascade" }),
  file: text("file").notNull(),
  line: integer("line"),
  category: text("category").notNull(),
  severity: severityEnum("severity").notNull(),
  title: text("title").notNull(),
  explanation: text("explanation").notNull(),
  suggestedFix: text("suggested_fix"),
  confidence: real("confidence").notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
export type Repo = typeof repos.$inferSelect;
export type NewRepo = typeof repos.$inferInsert;
export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
export type Finding = typeof findings.$inferSelect;
export type NewFinding = typeof findings.$inferInsert;
