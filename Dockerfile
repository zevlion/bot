FROM mcr.microsoft.com/devcontainers/base:bookworm

ENV LOCAL_WORKSPACE_FOLDER=/workspaces

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libwebp-dev \
    curl \
    bash \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Install NVM, Node.js (latest), and pm2
ENV NVM_DIR="/root/.nvm"
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash \
    && . "$NVM_DIR/nvm.sh" \
    && nvm install node \
    && nvm use node \
    && npm i -g pm2

# Make NVM and Node available in subsequent shells
RUN echo 'export NVM_DIR="/root/.nvm"' >> /root/.bashrc \
    && echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"' >> /root/.bashrc \
    && echo '[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"' >> /root/.bashrc

# Add Node to PATH for non-interactive shells (e.g. docker run commands)
RUN NODE_VERSION=$(ls /root/.nvm/versions/node/) \
    && ln -sf /root/.nvm/versions/node/$NODE_VERSION/bin/node /usr/local/bin/node \
    && ln -sf /root/.nvm/versions/node/$NODE_VERSION/bin/npm /usr/local/bin/npm \
    && ln -sf /root/.nvm/versions/node/$NODE_VERSION/bin/npx /usr/local/bin/npx \
    && ln -sf /root/.nvm/versions/node/$NODE_VERSION/bin/pm2 /usr/local/bin/pm2

USER root

WORKDIR /workspaces

CMD ["bash"]