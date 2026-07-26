# Architecture Decisions

## Token bucket over leaky bucket

- **Context**: Rate limiting algorithm selection
- **Decision**: Use token bucket
- **Rationale**: Simpler to reason about bursty traffic
