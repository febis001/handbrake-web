# Build client -------------------------------------------------------------------------------------
FROM node:20-alpine AS client-build

WORKDIR /handbrake-web/client

COPY client/package*.json /handbrake-web/client/

RUN npm install

COPY client/ /handbrake-web/client
COPY shared /handbrake-web/shared

RUN npm run build

# Main ---------------------------------------------------------------------------------------------
FROM node:20-alpine AS main

RUN apk add --no-cache python3 make g++ nano

WORKDIR /handbrake-web/server

COPY server/package*.json /handbrake-web/server/

# Install node dependencies
ENV NODE_ENV=production
RUN npm install

#!Important: Do npm install before copying the rest of the source files to leverage Docker's caching mechanism. 
# Copy rest of the server files
COPY server/ /handbrake-web/server

# Copy client build files and shared resources
COPY --from=client-build /handbrake-web/client/build /handbrake-web/client
COPY shared /handbrake-web/shared

# Create directories
RUN mkdir /data && chown node /data && mkdir /video && chown node /video

# Default environment variables & ports
EXPOSE 9999
ENV HANDBRAKE_MODE=server
ENV DATA_PATH=/data
ENV VIDEO_PATH=/video

# Dumb-init
RUN apk add dumb-init

# Start application
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["npm", "run", "prod"]
