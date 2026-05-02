# zevBot

zevBot is a modular and performant third-party WhatsApp client engineered to communicate with WA Servers via a Rust-based bridge for memory-safe and efficient protocol communication.

# Features

- SQLite Storage System
- Instant Message Sending
- WA Event Processing
- Message Scheduling
- Groups Management
- AppState Functionality
- Commands System

# Installation

## Docker Deployment

### Prerequisites

- **Docker** installed on your host machine.
- **Docker Compose** (optional, but recommended for simplified volume and permission management).

### Build and Run

To build the image and start the container manually, execute the following commands in the project root:

```bash
# Build the Docker image
docker build -t zevbot .

# Run the container
docker run -d --name zevbot-instance zevbot
```

### Development Containers

For contributors using **VS Code**, a pre-configured `.devcontainer` is provided. This environment includes all necessary dependencies and toolchains to streamline the development workflow without polluting the host system.

### Environment Configuration

The container utilizes a `config.toml` file for application settings. Ensure this file is properly configured before deployment. If you are running the bot in a production environment, it is advisable to mount your local configuration and session data as volumes to maintain persistence across container restarts:

```bash
docker run -d \
  --name zevbot-prod \
  -v $(pwd)/config.toml:/app/config.toml \
  -v $(pwd)/auth_info_baileys:/app/auth_info_baileys \
  zevbot
```

# License

This project is MIT licensed
