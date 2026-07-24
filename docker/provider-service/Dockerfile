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

FROM docker:27-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c
LABEL org.opencontainers.image.source="https://github.com/instafy-dev/instafy"
COPY --from=builder /src/packages/runtime-provider-service/target/release/runtime-provider-service /usr/local/bin/runtime-provider-service
EXPOSE 9090
ENTRYPOINT ["/usr/local/bin/runtime-provider-service"]
