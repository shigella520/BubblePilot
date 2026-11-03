FROM python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704 AS sqlite-builder
RUN sed -i "s|http://deb.debian.org|https://deb.debian.org|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 update \
    && apt-get install -y --no-install-recommends gcc make libc6-dev ca-certificates
# Official SQLite release; SHA-256 pinned after verifying the publisher's SHA3-256.
ADD --checksum=sha256:926ef8d3eab93fbf6e06011901273eec076b25594a4e1cdadd50c987f4f6d64e https://www.sqlite.org/2026/sqlite-autoconf-3540100.tar.gz /tmp/sqlite.tar.gz
RUN mkdir /tmp/sqlite && tar -xzf /tmp/sqlite.tar.gz -C /tmp/sqlite --strip-components=1 \
    && cd /tmp/sqlite && ./configure --prefix=/usr --libdir=/usr/lib/$(gcc -dumpmachine) --disable-readline --disable-static --disable-static-shell --enable-fts5 \
    && make -j2 && make DESTDIR=/opt/sqlite install \
    && rm -rf /opt/sqlite/usr/include /opt/sqlite/usr/share /opt/sqlite/usr/lib/*/pkgconfig \
    && mkdir -p /opt/sqlite/DEBIAN \
    && printf '%s\n' 'Package: bubblepilot-sqlite' 'Version: 3.54.1-1' \
       "Architecture: $(dpkg --print-architecture)" 'Maintainer: BubblePilot' \
       'Depends: libc6 (>= 2.38)' 'Provides: libsqlite3-0 (= 3.54.1), sqlite3 (= 3.54.1)' \
       'Conflicts: libsqlite3-0, sqlite3' 'Replaces: libsqlite3-0, sqlite3' \
       'Description: SQLite 3.54.1 official upstream build for BubblePilot' \
       > /opt/sqlite/DEBIAN/control \
    && dpkg-deb --build /opt/sqlite /opt/bubblepilot-sqlite.deb

FROM python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1 \
    XDG_CACHE_HOME=/tmp/cache PIP_CACHE_DIR=/tmp/pip-cache
COPY --from=sqlite-builder /opt/bubblepilot-sqlite.deb /tmp/bubblepilot-sqlite.deb
RUN sed -i "s|http://deb.debian.org|https://deb.debian.org|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 update && apt-get install -y --no-install-recommends \
    bash coreutils findutils grep sed ripgrep jq ca-certificates \
    iputils-ping iproute2 netcat-openbsd tar gzip zip unzip xz-utils file \
    diffutils patch procps /tmp/bubblepilot-sqlite.deb \
    && mkdir -p /opt/bubblepilot \
    && dpkg-query -W > /opt/bubblepilot/system-packages.tsv \
    && rm -rf /var/lib/apt/lists/* /tmp/bubblepilot-sqlite.deb
# The package replaces the old library while satisfying liblastlog2 dependencies.
RUN ldconfig && python -c "import sqlite3; assert sqlite3.sqlite_version == '3.54.1'" \
    && sqlite3 --version > /opt/bubblepilot/sqlite-version.txt
COPY plugins/opensandbox/runtime/requirements.lock /opt/bubblepilot/requirements.lock
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: -r /opt/bubblepilot/requirements.lock \
    && pip check && pip freeze --all > /opt/bubblepilot/python-packages.txt
COPY plugins/opensandbox/runtime/capabilities.json /opt/bubblepilot/capabilities.json
WORKDIR /workspace
CMD ["sleep", "infinity"]
