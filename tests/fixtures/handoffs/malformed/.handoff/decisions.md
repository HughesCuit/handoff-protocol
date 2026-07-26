# Architecture Decisions

## Retry over mocks

- **Context**: Flaky checkout test strategy
- **Decision**: Retry with backoff in CI only
- **Rationale**: Real checkout behavior must stay covered
