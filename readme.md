# Portifact

Publish static artifacts (HTML sites, Markdown and plain text) with their own URL, control who can see them, restore them after they expire, and collect annotations from authenticated reviewers. Agent-agnostic by design: use it from the CLI, a remote MCP server or the web dashboard.

> **Status:** in early development. The CLI does not have commands yet.

## Install

```bash
curl -fsSL https://portifact.com/install | bash
```

```powershell
irm https://portifact.com/install.ps1 | iex
```

The CLI is a single executable for Linux (glibc 2.17+ and Alpine), macOS and Windows, on x64 and arm64; it does not need Node or Bun. On Alpine, install `libstdc++` and `libgcc` first.

To teach your coding agent (Claude Code, Codex, Cursor and others) how to use Portifact:

```bash
npx skills add leynier/portifact
```

## Documentation

- [Releasing](docs/releasing.md), including how versions and installers work.
- [Security](docs/security.md), including how to report a vulnerability.
- [Testing](docs/testing.md)
- [Design system](docs/design.md)
- [Accessibility](docs/accessibility.md)
- [Agent guidelines](AGENTS.md) for AI coding agents working on this repository.

## License

[AGPL-3.0](license).
