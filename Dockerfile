# Sandbox images MUST base on cloudflare/sandbox:<ver> pinned to the same
# @cloudflare/sandbox npm version (0.12.9); never latest; never override ENTRYPOINT.
# judge-runner (built below) enforces per-submission CPU/memory/output/process limits.
FROM docker.io/cloudflare/sandbox:0.12.9@sha256:4a56a37a3cfd9b38d65bb4b5d0b341e6490a3a4c0226274ae4c1cca4948e85fe

RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc-12 g++-12 make python3 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/g++-12 /usr/local/bin/g++ \
    && ln -s /usr/bin/gcc-12 /usr/local/bin/gcc

COPY runner/judge-runner.cpp runner/Makefile /tmp/runner/
RUN make -C /tmp/runner \
    && install -m 0755 /tmp/runner/judge-runner /usr/local/bin/judge-runner \
    && rm -rf /tmp/runner

# Do NOT override `user` or `workdir`: the sandbox base runs /sandbox from
# /container-server as root to manage the container. Participant code runs
# unprivileged at runtime because judge-runner drops privileges in the child
# (setgroups/setgid/setuid to nobody) before execl - see backend
# architecture section A:23.
