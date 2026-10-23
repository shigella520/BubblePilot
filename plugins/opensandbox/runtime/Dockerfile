FROM python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1 \
    XDG_CACHE_HOME=/tmp/cache PIP_CACHE_DIR=/tmp/pip-cache
RUN sed -i "s|http://deb.debian.org|https://deb.debian.org|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 update && apt-get install -y --no-install-recommends \
    bash coreutils findutils grep sed ripgrep jq ca-certificates \
    iputils-ping iproute2 netcat-openbsd tar gzip zip unzip xz-utils file \
    diffutils patch procps sqlite3 \
    && mkdir -p /opt/bubblepilot \
    && dpkg-query -W > /opt/bubblepilot/system-packages.tsv \
    && rm -rf /var/lib/apt/lists/*
COPY plugins/opensandbox/runtime/requirements.lock /opt/bubblepilot/requirements.lock
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: -r /opt/bubblepilot/requirements.lock \
    && pip check && pip freeze --all > /opt/bubblepilot/python-packages.txt
COPY plugins/opensandbox/runtime/capabilities.json /opt/bubblepilot/capabilities.json
WORKDIR /workspace
CMD ["sleep", "infinity"]
