# QuickBooks MCP Server

## Project Overview

This is a Model Context Protocol (MCP) server that provides Claude with access to QuickBooks Online. It enables Claude to query, create, and edit accounting data including journal entries, bills, expenses, and reports.

## Git Workflow

This repo uses a branch-and-PR workflow. All changes to `master` land via pull request — the merge is a human gate. The agent drives work all the way to an open PR autonomously, then stops for the developer to review and merge.

### What the agent may and may not do

| Action                               | Autonomous?                              |
| ------------------------------------ | ---------------------------------------- |
| Commit to a work branch              | ✅ yes — no need to ask each time         |
| Push a work branch to `origin`       | ✅ yes                                    |
| Open a pull request (`gh pr create`) | ✅ yes                                    |
| Commit directly to `master`          | ❌ never                                  |
| Push to `master`                     | ❌ never                                  |
| Merge a pull request                 | ❌ never — the developer merges manually  |

There is no "merge locally and push to `master`" shortcut. The PR review/merge gate is intentional and must not be bypassed.

### Three-phase handoff

1. **Drive to PR (agent, autonomous).** Branch off the latest `master` (a git worktree is preferred), implement, build/verify, commit, push the work branch, and open a PR to `master` with `gh pr create` (descriptive title + body summarizing what changed and why). Then **stop** — do not merge.
2. **Merge (developer).** The developer reviews and merges the PR manually.
3. **Resume on merge confirmation (agent, autonomous).** Once the developer says the PR is merged, without being re-asked:
   - Pull the merged changes into the main checkout (`git switch master && git pull`), and rebuild if applicable.
   - Remove the git worktree (`git worktree remove <path>`).
   - Delete the local work branch with `git branch -D <branch>` (squash merges aren't recognized as "fully merged" by `-d`).
   - The **remote** branch is auto-deleted by GitHub's "Automatically delete head branches" setting (enabled on this repo), so no remote-deletion push is needed. Pushing any branch deletion — or anything else — to `master` stays hard-blocked/developer-only regardless.

### Conventions

- Start a branch from an up-to-date master: `git fetch origin && git switch -c <branch> origin/master` (or `git worktree add <path> -b <branch> origin/master`).
- **Branch naming**: `type/short-desc` — `feat/`, `fix/`, `docs/`, `chore/`, `refactor/`. E.g. `fix/scraper-popup`, `chore/bump-deps`.
- Give the PR a descriptive title and a body summarizing what changed and why.

## Architecture

```
src/
├── index.ts           # MCP server entry point (stdio)
├── lambda.ts          # Lambda entry point (HTTP transport)
├── client/            # QuickBooks API client and caching
├── types/             # TypeScript type definitions
├── utils/             # Utility functions (files, URLs, money, output)
├── query/             # Query helpers and pagination
├── reports/           # Report extraction helpers (P&L, Balance Sheet)
└── tools/
    ├── definitions.ts # All tool schema definitions (single file)
    ├── index.ts       # Tool registry, handler map, auth retry dispatcher
    └── handlers/      # One file per tool (or per entity group)
```

## Key Conventions

### Cents-Based Money Handling

All monetary calculations use integer cents to avoid floating-point precision errors:

```typescript
import { validateAmount, toCents, toDollars, sumCents, validateBalance } from "./utils/index.js";

// Validate input (rejects >2 decimal places)
const cents = validateAmount(amount, "Line description");  // throws if 10.001

// Sum safely (integer addition)
const totalCents = sumCents([amountACents, amountBCents]);

// Journal entries must balance exactly
validateBalance(debitsCents, creditsCents);  // throws if not equal
```

### Draft Mode for Writes

All write operations (create/edit) default to `draft: true`:
- Shows a preview of what would be created/modified
- User must explicitly set `draft: false` to commit changes
- Prevents accidental modifications to accounting data

### Account/Department Resolution

Names are auto-resolved to IDs using cached lookups:
- `account_name: "Tips"` → looks up ID from cache
- `department_name: "Santa Rosa"` → looks up ID from cache
- Caches are session-scoped with TTL

## Adding a New Tool

Every new tool requires changes in **4 files** plus README:

1. **`src/tools/handlers/<name>.ts`** — Create handler function
2. **`src/tools/handlers/index.ts`** — Add barrel export
3. **`src/tools/definitions.ts`** — Add tool schema (name, description, inputSchema)
4. **`src/tools/index.ts`** — Import handler + register in `toolHandlers.set()`
5. **`README.md`** — Add row to Available Tools table

Follow the pattern of the nearest existing tool. Use `outputReport()` for any tool that returns data (handles stdio vs HTTP mode automatically).

### HTTP Mode Context Budget

`outputReport()` behaves differently by transport:
- **stdio**: Writes full data to a temp file, returns summary text + filepath. Data never enters LLM context.
- **HTTP**: Returns summary text + **inline JSON**. Everything in the data object goes directly into the LLM's context window.

When building the `reportData` object passed to `outputReport()`, ask: **does the HTTP user need this data inline?**
- **Yes**: Structured summaries, metadata, entity objects needed for follow-up edits (SyncToken, line IDs)
- **No**: Raw API responses, full transaction lists for summary-only tools, redundant data the summary already covers

For tools that return large datasets, cap the detail for HTTP mode using `isHttpMode()` from `src/utils/output.ts`. Compute summaries from the full data, then truncate the detail. See `account-transactions.ts` (`HTTP_TXN_LIMIT`) for the pattern.

## Common Files

| Task | File |
|------|------|
| Change query behavior | `src/query/pagination.ts` |
| Money utilities | `src/utils/money.ts` |
| API client | `src/client/quickbooks.ts` |
| Output mode (stdio/http) | `src/utils/output.ts` |

## Critical Limitations

### Expenses Cannot Split Across Departments

QBO expenses (Purchases) only support **one department at the header level**. You cannot create an expense with lines in different departments. If a charge covers multiple locations:
- **Do NOT try to edit expense lines** — `edit_expense` with line changes strips `DepartmentRef` and `EntityRef` (vendor) from the header due to a bug in the full-update code path.
- **Use a reclassification JE** to move amounts between departments after the fact.
- **Use the bill-splitting workflow** (frontend) to create separate per-department bills from a single vendor invoice.

## Building and Testing

```bash
npm run build         # Compile TypeScript (tsc)
npm run build:lambda  # Bundle for Lambda (esbuild → dist-lambda/handler.mjs)
npm run watch         # Watch mode for development
```

Both builds must pass before committing. After changes, restart Claude Code to reload the MCP server.

## Workflow

- Feature backlog is tracked in `wmc-reconcile/docs/quickbooks-mcp-backlog.md` — move items to Completed when done
- Use `closes #N` in commit messages to auto-close GitHub issues
- Commit messages: short imperative subject, body explains the "why"

## QuickBooks API Notes

- All updates require `SyncToken` for optimistic concurrency
- Some entities require additional fields for sparse updates:
  - Bill: `VendorRef`
  - Purchase (Expense): `PaymentType`
- Department/Location filtering must be done client-side (not in QB queries)
- See `docs/quickbooks-api-limitations.md` for details
