FROM gcc:14-bookworm

RUN groupadd --gid 10001 judge \
    && useradd --uid 10001 --gid 10001 \
       --no-create-home --shell /usr/sbin/nologin judge

USER 10001:10001

WORKDIR /tmp