# syntax=docker/dockerfile:1.7

FROM rust:1.83-alpine AS builder
RUN apk add --no-cache musl-dev pkgconfig openssl-dev openssl-libs-static
WORKDIR /src

COPY packages/runtime-provider-core/Cargo.toml packages/runtime-provider-core/Cargo.toml
COPY packages/runtime-provider-core/src packages/runtime-provider-core/src
COPY packages/runtime-provider-service/Cargo.toml packages/runtime-provider-service/Cargo.toml
COPY packages/runtime-provider-service/Cargo.lock packages/runtime-provider-service/Cargo.lock
COPY packages/runtime-provider-service/src packages/runtime-provider-service/src

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    cargo build --release --manifest-path packages/runtime-provider-service/Cargo.toml --locked

FROM docker:27-cli
LABEL org.opencontainers.image.source="https://github.com/instafy-dev/instafy"
COPY --from=builder /src/packages/runtime-provider-service/target/release/runtime-provider-service /usr/local/bin/runtime-provider-service
EXPOSE 9090
ENTRYPOINT ["/usr/local/bin/runtime-provider-service"]
