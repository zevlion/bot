# zevBot

## Installation

### Docker Deployment

#### Prerequisites

- **Docker** installed on your host machine.
- **Docker Compose** (optional, but recommended for simplified volume and permission management).

#### Pull from GitHub Container Registry

The latest image is published to GHCR and can be pulled directly:

```bash
docker pull ghcr.io/zevlion/zevbot:latest
```

#### Build and Run

Build the image locally from source:

```bash
# Build the Docker image
docker build -t zevbot .

# Run the container
docker run -d --name zevbot-instance zevbot
```

Alternatively, To use the pre-built image instead (Recommended):

```bash
docker run -d --name zevbot-instance ghcr.io/zevlion/zevbot:latest
```

#### Development Containers

For contributors using **VS Code** and **Zed**, a pre-configured `.devcontainer` is provided. This environment includes all necessary dependencies and toolchains to streamline the development workflow without polluting the host system.

```bash
docker run -d \
  --name zevbot-prod \
  ghcr.io/zevlion/zevbot:latest
```

# License

This project is licensed under the terms of the MIT License. The software is provided "as is", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose and noninfringement. In no event shall the authors or copyright holders be liable for any claim, damages or other liability, whether in an action of contract, tort or otherwise, arising from, out of or in connection with the software or the use or other dealings in the software.
