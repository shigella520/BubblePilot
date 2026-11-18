# Feasibility only: same Python base as the sandbox, not the production image.
FROM python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704
COPY .assets/resvg.tar.gz /tmp/resvg.tar.gz
RUN echo '3c1d52850a78bc4ed0e9d05605b53ad21bb5313184f14bf72515d29cb98cda10  /tmp/resvg.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/resvg.tar.gz -C /usr/local/bin && rm /tmp/resvg.tar.gz
COPY .assets/NotoSansCJKsc-Regular.otf /usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf
RUN echo '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b  /usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf' | sha256sum -c -
RUN pip install --no-cache-dir Pillow==13.0.0
WORKDIR /workspace
