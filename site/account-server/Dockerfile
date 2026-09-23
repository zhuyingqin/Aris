FROM rust:1.96-bookworm AS build
WORKDIR /src
COPY site/account-server/Cargo.toml site/account-server/Cargo.lock ./
COPY site/account-server/src ./src
COPY site/account-server/web ./web
COPY site/account-server/schema.sql ./schema.sql
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10002 somniq && useradd --system --uid 10002 --gid somniq somniq \
    && mkdir /data && chown somniq:somniq /data
COPY --from=build /src/target/release/somniq-account-server /usr/local/bin/somniq-account-server
USER somniq:somniq
ENV SOMNIQ_ACCOUNT_BIND=0.0.0.0:8800 SOMNIQ_ACCOUNT_DATABASE=/data/accounts.sqlite3
EXPOSE 8800
ENTRYPOINT ["somniq-account-server"]
