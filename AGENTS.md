<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Environment variables and secrets

Before planning or making any change that adds, removes, renames, moves or rotates an environment variable or secret
(Vercel, GitHub Actions secrets, Terraform variables / Lambda environments, the Trade Assistant machine), read
`docs/env.md`. Update it in the same change, and make the plan list every place the value must be set: several values
live in more than one place and must be changed together.
