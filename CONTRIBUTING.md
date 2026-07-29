# Contributing to Handoff Protocol

Thank you for your interest in contributing to Handoff Protocol!

## How to Contribute

### Reporting Issues

- Use GitHub Issues to report bugs
- Include steps to reproduce the issue
- Include your environment (OS, agent, version)

### Suggesting Features

- Open a GitHub Issue with the `enhancement` label
- Describe the use case and expected behavior

### Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Development

### Directory Structure

```
handoff-protocol/
├── SKILL.md              # Main skill definition
├── scripts/              # Executable scripts (+ shared context-map.mjs core)
├── tests/                # Fixture-based tests (Deno + Node, shared fixtures)
├── references/           # Documentation
├── assets/               # Templates and resources
├── README.md
├── CONTRIBUTING.md
├── LICENSE
└── package.json
```

### Testing

Before submitting, ensure:

1. Your changes follow the [Agent Skills specification](https://agentskills.io/specification)
2. SKILL.md has valid YAML frontmatter
3. Scripts are executable and documented
4. No sensitive data is included
5. Both test suites pass (they share fixtures, so both must stay green):

```bash
deno test --allow-read --allow-write --allow-run --allow-env tests/deno/
node --test "tests/node/**/*.test.mjs"
```

### Evaluation Runner

`scripts/evaluate.mjs` measures save quality against a synthetic project built
in a temporary directory (source fixtures are never modified). It reports the
duplicate rate and map growth across repeated saves, user-edit retention, and
Node/Deno runtime parity:

```bash
node scripts/evaluate.mjs                          # parity leg skipped if deno is not in PATH
node scripts/evaluate.mjs --deno /path/to/deno     # explicit deno binary
```

The runner exits non-zero when duplicates appear, user edits are lost, or the
runtimes diverge.

## Code of Conduct

Please be respectful and inclusive in all interactions.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
