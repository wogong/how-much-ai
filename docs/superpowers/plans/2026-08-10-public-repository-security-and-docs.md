# Public Repository Security and Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove current dependency advisories, strengthen public setup instructions, add a verified live-site preview, and publish the changes while preserving a clean single-branch repository.

**Architecture:** Keep application behavior unchanged. Make one minimal dependency-resolution change, add one public screenshot, and reorganize the README around local setup, AI-agent setup, optional BYO Convex, and the clearly separated managed-hosting alternative. Verify the complete public history and merged remote state.

**Tech Stack:** Next.js 16, React 19, TypeScript 6, npm, Convex, GitHub Actions, Gitleaks, Markdown, Codex in-app browser.

## Global Constraints

- Modify only `SeraphKc/how-much-ai`; do not copy private production code, configuration, history, identifiers, or credentials.
- Preserve public history and `v0.1.1`; do not force-push without a verified historical disclosure.
- Keep self-hosting free, unlimited, single-tenant, and bring-your-own infrastructure.
- Do not add hosted authentication, billing, analytics, provider locks, production identifiers, or private support details.
- The final remote must retain only protected `main` plus the existing intended tag.
- Do not commit scanner reports, `.env*`, `.data/`, generated runtime state, or browser/session data.

---

### Task 1: Remediate dependency advisories

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: the existing npm graph and Node.js `>=22.18.0` requirement.
- Produces: PostCSS `8.5.26`, Nano ID at least `3.3.17`, and zero known npm vulnerabilities.

- [ ] **Step 1: Preserve the failing baseline**

Run `npm audit --json`. Expected: two high and one moderate finding involving `postcss`, `nanoid`, and the transitive `next` path.

- [ ] **Step 2: Apply the smallest constraint**

Replace the override block in `package.json` with:

```json
"overrides": {
  "postcss": "8.5.26",
  "next": {
    "sharp": "0.35.3"
  }
}
```

- [ ] **Step 3: Regenerate npm-managed state**

Run `npm install --package-lock-only` and `npm ci`.

- [ ] **Step 4: Verify the remediation**

Run `npm ls postcss nanoid next --all` and `npm audit --audit-level=moderate`. Expected: PostCSS `8.5.26`, Nano ID `>=3.3.17`, zero vulnerabilities.

- [ ] **Step 5: Commit**

Stage only `package.json` and `package-lock.json`; commit as `fix: remediate dependency advisories`.

---

### Task 2: Capture and verify the hosted preview

**Files:**
- Create: `docs/images/how-much-usage-landing.png`

**Interfaces:**
- Consumes: the unauthenticated public page at `https://howmuchusage.ai/`.
- Produces: a desktop PNG containing only public marketing content.

- [ ] **Step 1: Verify visible pricing**

Confirm on the live page: one account free, `$15` one-time combined hosted unlock, no subscription, and self-hosting remains free. Verify the matching page before mentioning a `$9` single-provider offer.

- [ ] **Step 2: Capture a stable viewport**

Capture a normal unauthenticated desktop viewport showing the hero and product preview, then crop away browser or navigation chrome if needed. Save it as `docs/images/how-much-usage-landing.png`.

- [ ] **Step 3: Inspect the image**

Confirm visually that the PNG contains no signed-in state, real account data, browser chrome, or local path. Run `file docs/images/how-much-usage-landing.png` and remove incidental metadata only if present.

---

### Task 3: Improve setup documentation

**Files:**
- Modify: `README.md`
- Read/verify: `AGENTS.md`
- Read/verify: `.env.example`
- Read/verify: `docs/SELF_HOSTING.md`
- Read/verify: `docs/images/how-much-usage-landing.png`

**Interfaces:**
- Consumes: existing setup commands, environment names, and verified hosted pricing.
- Produces: human, AI-agent, BYO Convex, and optional hosted paths with no production-specific values.

- [ ] **Step 1: Add the linked preview**

Use this Markdown immediately after the product boundary:

```markdown
[![How Much Usage hosted landing page](docs/images/how-much-usage-landing.png)](https://howmuchusage.ai/)

*Preview the managed version at [howmuchusage.ai](https://howmuchusage.ai/). The repository itself remains free to self-host with unlimited accounts.*
```

- [ ] **Step 2: Add the AI-agent brief**

Tell an LLM to read `AGENTS.md`, run `npm ci` then `npm run dev`, use only fresh user-owned credentials, copy `.env.example` only when configuration is needed, and validate with `npm test`, `npm run typecheck`, and `npm run build`.

- [ ] **Step 3: Add concise BYO Convex steps**

Document `npx convex dev` and `npx convex env set VAULT_ACCESS_SECRET`. Explain that the generated URL and a new deployment-specific secret go into `.env.local`. Link `docs/SELF_HOSTING.md` for production deployment, scheduler, notifications, rotation, and backups.

- [ ] **Step 4: Add optional hosted pricing**

State clearly: self-hosted is free and unlimited; How Much Usage hosted includes one free account and costs `$15` once for unlimited combined Claude and ChatGPT/Codex accounts, with no subscription. Mention a `$9` single-provider edition only after live verification.

- [ ] **Step 5: Verify references**

Confirm all referenced files exist; search the README for `howmuchusage.ai`, `$15`, `npx convex dev`, `VAULT_ACCESS_SECRET`, and `AGENTS.md`; check the live URL; run `git diff --check`.

- [ ] **Step 6: Commit**

Stage only `README.md` and `docs/images/how-much-usage-landing.png`; commit as `docs: improve self-hosting and hosted preview`.

---

### Task 4: Complete local and history verification

**Files:**
- Inspect: all tracked files and reachable commits.
- Do not commit: scanner reports stored outside the repository.

**Interfaces:**
- Consumes: completed dependency, image, and README changes.
- Produces: fresh correctness, security, privacy, and scope evidence.

- [ ] **Step 1: Run application validation**

Run `npm ci`, `npm test`, `npm run typecheck`, and `npm run build`. Expected: 311 tests pass, type-check succeeds, build succeeds, and the vault-trace assertion excludes local vault material.

- [ ] **Step 2: Re-run dependency and GitHub checks**

Run `npm audit --audit-level=moderate` and query GitHub secret-scanning and Dependabot alerts. Expected: no current-tree advisory and no open secret alert.

- [ ] **Step 3: Scan complete proposed history**

Run Gitleaks against all commits with full redaction. Review the fixed `__hmc_vault_key_proof_v1__` result as the known non-secret identifier. Search every reachable commit for live-secret prefixes, production Convex hosts, absolute local home-directory paths, and non-example email domains.

- [ ] **Step 4: Review publication scope**

Run `git status --short`, `git diff origin/main...HEAD --check`, `git diff --stat origin/main...HEAD`, and `git log --oneline origin/main..HEAD`. Expected: only the specification, plan, dependency files, README, and screenshot.

---

### Task 5: Publish and restore the single-branch remote

**Files:**
- Publish: branch `chore/security-docs-audit`.

**Interfaces:**
- Consumes: the verified local branch.
- Produces: merged protected `main`, one pull request, and no remaining temporary branch.

- [ ] **Step 1: Commit the plan**

Stage only this plan and commit as `docs: add public audit implementation plan`.

- [ ] **Step 2: Push the verified branch**

Run `git push -u origin chore/security-docs-audit`.

- [ ] **Step 3: Open one ready pull request**

Use base `main` and head `chore/security-docs-audit`. Summarize dependency remediation, public-history audit, README improvements, screenshot, and validation evidence.

- [ ] **Step 4: Wait for required checks and merge**

Require the test/type-check/build workflow to pass, merge using the repository-supported method, and confirm automatic branch deletion.

- [ ] **Step 5: Verify remote final state**

Confirm only `refs/heads/main`, the existing `v0.1.1` tag, and no open secret or dependency alert attributable to merged `main`.
