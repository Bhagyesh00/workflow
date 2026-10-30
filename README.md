# Workflow Platform

Multi-tenant, white-label workflow automation: visual node-graph editor, sandboxed expressions and code, credentials vault, webhooks and schedules, AI agent nodes, and app integrations.

- Architecture & contracts: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Feature parity & roadmap: [docs/SPEC.md](docs/SPEC.md)

## Development

```bash
pnpm install
pnpm test        # all packages
pnpm typecheck
pnpm lint
```

Requires Node.js 22.19+ (24 LTS recommended). Code-node sandboxing uses `isolated-vm`, so Node must run with `--no-node-snapshot` (already set in the package scripts).
