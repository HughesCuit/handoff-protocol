# Skills CLI Distribution v2.4.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npx skills add HughesCuit/handoff-protocol` the primary installation path, document honest agent compatibility tiers, and verify the repository remains discoverable by the Skills CLI.

**Architecture:** Keep the repository root as the single `handoff` skill and retain all existing installers as alternatives. Add a small black-box smoke check around the external Skills CLI, update README installation and compatibility copy, then release the documentation-and-validation change as v2.4.1 without changing protocol schema or command behavior.

**Tech Stack:** Markdown, Node.js test runner, npm/npx, GitHub Actions, Skills CLI.

## Global Constraints

- The canonical install command is `npx skills add HughesCuit/handoff-protocol`.
- Do not publish `handoff-protocol` as an npm package merely to distribute the skill; npm only supplies the `npx skills` launcher.
- Keep the root `SKILL.md` layout and existing manual installers compatible.
- Distinguish “installable through Skills CLI” from “verified by Handoff Protocol”.
- Core verified/documented agents: Codex, Claude Code, OpenCode, and Kimi Code CLI.
- Compatibility-documented agents: OpenHands and Cursor.
- Other Skills CLI targets are described as expected basic-skill compatibility, not as fully tested.
- `/handoff view` requires Node.js; Deno continues returning the existing actionable `VIEW_REQUIRES_NODE` result.
- Do not change the `.handoff/` protocol schema (`PROTOCOL_VERSION` remains `2.0.0`).

---

### Task 1: Add a Skills CLI discovery smoke check

**Files:**
- Create: `.github/workflows/skills-cli-smoke.yml`
- Modify: `package.json`

**Interfaces:**
- Consumes: repository-root `SKILL.md` and the public `skills` CLI.
- Produces: npm script `test:skills` and a CI job that fails when the CLI cannot discover the root skill named `handoff`.

- [ ] **Step 1: Record the expected discovery output**

Run from the repository root:

```bash
npx --yes skills@latest add . --list
```

Expected: exit code `0`, output includes `handoff`, and exactly one repository skill is discovered.

- [ ] **Step 2: Add the smoke-test npm script**

Add this script to `package.json`:

```json
"test:skills": "npx --yes skills@latest add . --list"
```

Do not add the Skills CLI as a runtime dependency.

- [ ] **Step 3: Add the CI workflow**

Create `.github/workflows/skills-cli-smoke.yml` with `pull_request`, `push` to `main`, and `workflow_dispatch` triggers. Use `actions/checkout@v4`, `actions/setup-node@v4` with Node 22, run `npm run test:skills`, and assert the command succeeds.

- [ ] **Step 4: Verify local discovery**

Run:

```bash
npm run test:skills
```

Expected: exit code `0` and `handoff` appears in the discovery output.

- [ ] **Step 5: Commit the independently testable validation change**

```bash
git add package.json .github/workflows/skills-cli-smoke.yml
git commit -m "test: verify Skills CLI discovery"
```

### Task 2: Make Skills CLI the primary documented installer

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the `test:skills` contract from Task 1.
- Produces: copyable default, targeted, project-local, and global installation examples.

- [ ] **Step 1: Add the primary installation command**

Place this first under `## Installation`:

```bash
npx skills add HughesCuit/handoff-protocol
```

Explain that the interactive CLI detects supported agents and asks for installation scope.

- [ ] **Step 2: Add explicit agent examples**

Document representative targeted installs:

```bash
npx skills add HughesCuit/handoff-protocol --agent codex
npx skills add HughesCuit/handoff-protocol --agent claude-code
npx skills add HughesCuit/handoff-protocol --agent opencode
npx skills add HughesCuit/handoff-protocol --agent kimi-code-cli
```

Only use flags confirmed by the installed Skills CLI help. If the CLI spells a target differently, use its exact identifier.

- [ ] **Step 3: Demote existing installers without removing them**

Rename the clone/symlink and Codex-specific sections to “Manual installation”. Preserve their commands for pinned, offline, and unsupported-host setups. Keep MimoCode described only in this manual section unless Skills CLI reports it as a target.

- [ ] **Step 4: Validate every documented command**

Run:

```bash
npx --yes skills@latest add --help
npm run test:skills
```

Expected: every shown option and target identifier is accepted by the current CLI; local discovery still finds `handoff`.

- [ ] **Step 5: Commit the installation documentation**

```bash
git add README.md
git commit -m "docs: recommend Skills CLI installation"
```

### Task 3: Publish an honest agent compatibility policy

**Files:**
- Modify: `README.md`
- Modify: `SKILL.md`

**Interfaces:**
- Consumes: current root skill behavior and `/handoff view` runtime boundary.
- Produces: one consistent compatibility matrix and matching skill metadata copy.

- [ ] **Step 1: Add the compatibility tiers**

Add a table with these meanings:

| Tier | Agents | Claim |
|---|---|---|
| Core verified | Codex, Claude Code, OpenCode, Kimi Code CLI | Installation and core handoff workflow are explicitly supported and used for release documentation. |
| Compatible | OpenHands, Cursor | Basic `SKILL.md`, filesystem, and shell workflow is supported; host UX may differ. |
| Skills CLI ecosystem | Other targets reported by Skills CLI | Expected to work when the host supports basic skills, filesystem access, and command execution; not individually certified by this project. |

Link to the official Skills CLI repository for its changing full target list instead of copying all 70+ names into this repository.

- [ ] **Step 2: Document capability boundaries**

State that Handoff uses basic `SKILL.md` semantics and does not require Claude-only hooks or `context: fork`. State that `/handoff view` requires Node.js and a host capable of opening or presenting the returned loopback URL.

- [ ] **Step 3: Align the skill description**

Update `SKILL.md` frontmatter description so it names the core verified agents without claiming certification for every Skills CLI target. Do not change the skill name or command contract.

- [ ] **Step 4: Check consistency and formatting**

Run:

```bash
rg -n "Universal|supported agents|Core verified|Kimi|MimoCode|Skills CLI" README.md SKILL.md
git diff --check
```

Expected: no contradictory universal-compatibility claim and no whitespace errors.

- [ ] **Step 5: Commit the compatibility policy**

```bash
git add README.md SKILL.md
git commit -m "docs: define agent compatibility tiers"
```

### Task 4: Prepare and verify v2.4.1

**Files:**
- Modify: `package.json`
- Modify: `SKILL.md`

**Interfaces:**
- Consumes: completed Tasks 1–3.
- Produces: a releasable v2.4.1 tree; tag, push, and GitHub Release remain separate authorized release actions.

- [ ] **Step 1: Set the product version**

Change `package.json` version to `2.4.1`. If `SKILL.md` contains release metadata, set it to `2.4.1`; leave protocol schema references at `2.0.0`.

- [ ] **Step 2: Run the full release checks**

Run:

```bash
npm test
npm run test:deno
npm run test:skills
npm pack --dry-run
git diff --check
```

Expected: Node and Deno tests pass, Skills CLI discovers `handoff`, the package dry run contains `SKILL.md` and required scripts/viewer assets, and no formatting errors are reported.

- [ ] **Step 3: Verify the clean-install command against GitHub**

After the v2.4.1 commit is reachable on GitHub, run in a temporary directory:

```bash
npx --yes skills@latest add HughesCuit/handoff-protocol --list
```

Expected: one skill named `handoff` is found. Do not install into the user's real agent directories during this check.

- [ ] **Step 4: Commit the release preparation**

```bash
git add package.json SKILL.md
git commit -m "release: prepare 2.4.1"
```

- [ ] **Step 5: Release only after explicit authorization**

Confirm the branch is based on current `main`, create and push tag `v2.4.1`, then create a GitHub Release summarizing Skills CLI installation and compatibility tiers. This step must not publish an npm package.

## Self-Review

- Spec coverage: primary Skills CLI command, representative agent targets, compatibility tiers, legacy installers, CI discovery, Node requirement, version boundary, and release gates each have an owning task.
- Placeholder scan: the plan contains no deferred implementation placeholders.
- Interface consistency: `test:skills` is introduced in Task 1 and reused unchanged in Tasks 2 and 4; product version `2.4.1` remains distinct from schema `2.0.0`.
