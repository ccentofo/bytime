<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Start every session here

Read `LAUNCH-TRACKER.md` (repo root) before doing anything else. It is the source of truth for:
- the build queue and what's in progress;
- the product owner's decisions;
- open questions;
- what's deferred.

Scope belongs to the product owner: don't add, remove or change what the product does without their yes, and bring assumptions to them instead of deciding.

**Git rules:**
- Every work item (a blueprint, a fix round series, a hotfix) gets its **own new branch from the latest `main`**.
- Never commit to `main`.
- Never push, force-push or rewrite history that has been pushed.
- Only the product owner pushes and merges, and only after confirming the work is stable on their machine.
