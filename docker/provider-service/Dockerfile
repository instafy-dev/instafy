# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM rust:1.83-alpine@sha256:0ac946ed7597a9f053a1be2ce38c09aa88b3d7079a91ea491493615294b1f699 AS builder
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

FROM alpine:3.23@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40
ARG DOCKER_CLI_VERSION=29.5.2-r0
ARG DOCKER_BUILDX_VERSION=0.30.1-r6
ARG DOCKER_COMPOSE_VERSION=2.40.3-r6
RUN apk add --no-cache \
    "docker-cli=${DOCKER_CLI_VERSION}" \
    "docker-cli-buildx=${DOCKER_BUILDX_VERSION}" \
    "docker-cli-compose=${DOCKER_COMPOSE_VERSION}"
LABEL org.opencontainers.image.source="https://github.com/instafy-dev/instafy"
COPY --from=builder /src/packages/runtime-provider-service/target/release/runtime-provider-service /usr/local/bin/runtime-provider-service
EXPOSE 9090
ENTRYPOINT ["/usr/local/bin/runtime-provider-service"]
