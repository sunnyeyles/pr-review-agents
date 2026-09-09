# @pr-review/db

Postgres on Neon, accessed through Drizzle. `db()` returns the client; the
tables are exported from `src/schema.ts`.

```mermaid
erDiagram
  teams |o--o{ users : "has"
  teams ||--o{ repos : "owns"
  repos ||--o{ reviews : "collects"
  reviews ||--o{ findings : "holds"

  users {
    serial id PK
    int github_id UK
    text login
    text name
    text email
    text avatar_url
    int team_id FK
    role role "owner admin member"
  }
  teams {
    serial id PK
    text slug UK "subdomain"
    text name
    text github_org
  }
  repos {
    serial id PK
    int team_id FK
    text owner
    text name
  }
  reviews {
    serial id PK
    int repo_id FK
    int pr_number
    text head_sha
    text[] agents
    text summary
  }
  findings {
    serial id PK
    int review_id FK
    text file
    int line
    text category
    severity severity "low medium high"
    text title
    text explanation
    text suggested_fix
    real confidence
  }
```

- `teams.slug` is the subdomain: `acme` → `acme.<app-domain>`.
- One team per user: `users.team_id`, null until they create or join one.
  Many teams per user later means moving that column into a join table.
- Deleting a team cascades to its repos, reviews and findings; its users stay
  and get `team_id = null`.

## Commands

```bash
pnpm db:generate   # write a migration from schema changes
pnpm db:push       # apply the schema straight to DATABASE_URL (dev)
pnpm db:migrate    # apply pending migrations
pnpm db:studio     # browse the data
```

`DATABASE_URL` comes from Vercel in production and from the nearest
`.env.local` locally.
