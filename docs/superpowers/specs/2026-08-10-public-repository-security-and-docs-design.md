# Public Repository Security and Documentation Design

## Objective

Keep `SeraphKc/how-much-ai` as the public, MIT-licensed, self-hosted edition while verifying that its current tree and complete public history contain no user-specific secrets, personal information, deployment identifiers, or production-only reconnaissance data. Improve setup documentation, remove current dependency advisories, and show the public hosted alternative without adding hosted-only code to the repository.

## Scope and boundaries

- Modify only the public `SeraphKc/how-much-ai` repository.
- Do not copy files, configuration, billing code, identity code, production topology, environment values, or Git history from either private production repository.
- Preserve the existing four-commit public history and the `v0.1.1` tag unless a verified historical disclosure makes a rewrite necessary.
- Keep the public edition self-hosted, single-tenant, free, and unlimited.
- Keep all infrastructure bring-your-own: Convex, Redis/KV, notification services, hosting, and provider credentials.
- Do not add analytics, hosted authentication, billing, provider locks, production deployment identifiers, or private support details.

## Security audit and remediation

The audit covers both the checked-out tree and every reachable public commit. It checks:

- GitHub secret-scanning alerts and repository security settings;
- Gitleaks full-history results;
- common provider, GitHub, Stripe, webhook, and cloud-secret formats;
- Convex deployment hostnames and deployment identifiers;
- personal email addresses, local filesystem paths, private IP addresses, logs, dumps, vaults, environment files, and generated artifacts;
- commit author email domains, branches, tags, and branch-protection posture;
- dependency advisories from GitHub and `npm audit`;
- repository tests that protect credentials, vault isolation, request boundaries, and remote storage behavior.

The fixed `__hmc_vault_key_proof_v1__` compatibility identifier in `convex/vault.ts` is not a credential. A generic-secret scanner may classify it as a possible API key; the final audit will record it as a reviewed false positive without weakening source-code validation around real credentials.

The current dependency findings must be remediated with the smallest compatible package and lockfile update. The final state must report zero known `npm audit` vulnerabilities. Application behavior must remain unchanged and the existing test, type-check, build, and vault-trace checks must pass.

## Branch and history posture

The final remote state will retain only protected `main`. Work will occur on one temporary branch, be reviewed through one pull request, and be merged only after required checks pass. The repository's automatic branch deletion will remove the temporary branch after merge. No force-push or history rewrite is planned because the existing public history contains no verified secret.

## README and setup documentation

The README will remain concise enough for a first-time installer while adding four clearer paths:

1. **Hosted preview and alternative.** Link the screenshot and call to action to `https://howmuchusage.ai/`. State that self-hosting is free and unlimited. Distinguish that from the optional managed service: one hosted account is free; unlimited combined Claude and ChatGPT/Codex accounts cost a one-time `$15`, with no subscription. Mention the one-time `$9` single-provider hosted editions only after their live pages and displayed pricing are verified.
2. **Human quick start.** Preserve the deterministic Node.js, clone, `npm ci`, `npm run dev`, and localhost instructions. Keep the warning that zero-configuration mode is open and intended only for a trusted machine or network.
3. **AI-agent entry point.** Add a short copyable setup brief that tells an LLM to read `AGENTS.md`, use `.env.example` only as a template, never import production credentials, and run the repository's required validation commands.
4. **Bring-your-own Convex.** Add a short route from the README to the complete `docs/SELF_HOSTING.md` procedure: run `npx convex dev`, set a new deployment-specific `VAULT_ACCESS_SECRET` in both the app and that Convex project, use the generated deployment URL, and deploy the functions. The detailed guide remains authoritative for production, notifications, backups, and rotation.

Documentation must not imply that Convex is required for local use, that the hosted fee applies to self-hosting, or that users should reuse any deployment or credentials owned by the maintainer.

## Landing-page snapshot

Capture a fresh desktop screenshot from the unauthenticated public landing page at `https://howmuchusage.ai/`. The image will show the public hero and product preview, not an authenticated account, browser chrome, cookies, local files, or real customer data. Save the optimized image under `docs/images/` with descriptive alternative text and a linked caption in the README. Verify the image visually before commit and remove unnecessary metadata if present.

## Validation and acceptance criteria

Before publication:

- the remote exposes only `main` plus the existing intended tag;
- GitHub secret scanning has no open alert;
- the full-history scanner has no unreviewed finding;
- custom history and current-tree searches find no personal data, local paths, live-secret formats, or production Convex hostnames;
- `npm audit` reports zero vulnerabilities;
- all existing tests pass;
- type-checking succeeds;
- the production build and vault-trace assertion succeed;
- README links, commands, paths, environment names, pricing, and hosted URLs are correct;
- the screenshot renders cleanly in Markdown and contains only public landing-page content;
- the final diff contains no environment values, generated runtime data, scanner reports, or unrelated private-repository material;
- the temporary branch is removed after merge.

## Publication

Stage only the audited dependency, documentation, and screenshot files. Create focused commits on the temporary branch, push that branch, open one ready pull request, wait for required checks, merge it, confirm branch deletion, and then repeat the external repository and secret-scanning checks against the merged `main` branch.
