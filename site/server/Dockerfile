# syntax=docker/dockerfile:1.7
#
# Build from the repository root so Cargo can resolve the shared
# crates/remote-protocol workspace metadata:
#   docker build -f site/server/Dockerfile .

FROM rust:1.96-bookworm AS builder

WORKDIR /workspace

# Configure fast mirror for crates.io
RUN mkdir -p /usr/local/cargo && printf '[source.crates-io]\nreplace-with = "tuna"\n\n[source.tuna]\nregistry = "sparse+https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/"\n' > /usr/local/cargo/config.toml

# remote-protocol inherits package and lint metadata from the root workspace.
COPY Cargo.toml Cargo.lock ./
COPY crates/remote-protocol ./crates/remote-protocol
COPY site/server ./site/server

RUN cargo build --release --locked \
    --manifest-path site/server/Cargo.toml

FROM debian:bookworm-slim AS runtime

# curl backs the container-only health check.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 somniq \
    && useradd --system --uid 10001 --gid somniq --no-create-home somniq

COPY --from=builder --chown=somniq:somniq \
    /workspace/site/server/target/release/somniq-remote-gateway \
    /usr/local/bin/somniq-remote-gateway

ENV SOMNIQ_GATEWAY_BIND=0.0.0.0:8787 \
    RUST_LOG=somniq_remote_gateway=info

EXPOSE 8787
USER somniq:somniq

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl --fail --silent --show-error http://127.0.0.1:8787/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/somniq-remote-gateway"]
