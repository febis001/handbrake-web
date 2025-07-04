# Use handbrake pre-compiled with NVENC and NVDEC support
FROM zocker160/handbrake-nvenc:latest AS handbrake_source

# Install node v20
RUN groupadd --gid 1000 node \
  && useradd --uid 1000 --gid node --shell /bin/bash --create-home node

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
		ca-certificates curl wget gnupg dirmngr xz-utils libatomic1 \
        dumb-init \
		curl \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN curl -sL https://deb.nodesource.com/setup_20.x -o nodesource_setup.sh
RUN bash nodesource_setup.sh
RUN apt install -y --no-install-recommends nodejs

RUN node -v

# Set the working directory for your application.
WORKDIR /handbrake-web/worker

# Copy package definition files.
COPY worker/package*.json /handbrake-web/worker/

# Install Node.js dependencies.
ENV NODE_ENV=production
RUN npm install

# Copy the rest of your application source code.
COPY worker/ /handbrake-web/worker/
COPY shared /handbrake-web/shared/

# Create necessary directories and set ownership to the non-root 'node' user.
RUN mkdir -p /data /video && chown node:node /data /video

# Set default environment variables.
ENV HANDBRAKE_MODE=worker
ENV DATA_PATH=/data
ENV VIDEO_PATH=/video

# Set the entrypoint to dumb-init to properly handle signals.
# This overrides the base image's entrypoint.
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Set the default command to run your Node.js application.
CMD ["npm", "run", "prod"]
