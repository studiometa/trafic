#!/bin/bash
#
# Trafic Agent Installer
# 
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/studiometa/trafic/main/scripts/install.sh | sudo bash -s -- --tld=previews.example.com
#
# Options:
#   --tld=<domain>       TLD for DDEV projects (required)
#   --email=<email>      Email for Let's Encrypt certificates
#   --no-hardening       Skip server hardening
#   --no-docker          Skip Docker installation
#   --no-ddev            Skip DDEV installation
#   --dry-run            Show what would be done
#
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

log() { echo -e "${CYAN}[trafic]${NC} $1"; }
success() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1"; exit 1; }

# Parse arguments
SETUP_ARGS=""
for arg in "$@"; do
  case $arg in
    --tld=*)
      TLD="${arg#*=}"
      SETUP_ARGS="$SETUP_ARGS $arg"
      ;;
    --email=*|--no-hardening|--no-docker|--no-ddev|--dry-run|--ssh-users=*)
      SETUP_ARGS="$SETUP_ARGS $arg"
      ;;
    *)
      warn "Unknown option: $arg"
      ;;
  esac
done

# Check TLD
if [ -z "$TLD" ]; then
  error "Missing required option: --tld=<domain>

Usage:
  curl -fsSL https://... | sudo bash -s -- --tld=previews.example.com

Options:
  --tld=<domain>       TLD for DDEV projects (required)
  --email=<email>      Email for Let's Encrypt certificates  
  --no-hardening       Skip server hardening
  --no-docker          Skip Docker installation
  --no-ddev            Skip DDEV installation
  --ssh-users=<users>  Comma-separated SSH users to allow
  --dry-run            Show what would be done"
fi

# Check root
if [ "$EUID" -ne 0 ]; then
  error "This script must be run as root. Use: sudo bash -s -- ..."
fi

# Check OS
if [ ! -f /etc/os-release ]; then
  error "Cannot detect OS. This script requires Ubuntu 24.04."
fi

source /etc/os-release
if [ "$ID" != "ubuntu" ] || [ "${VERSION_ID%%.*}" -lt 24 ]; then
  error "This script requires Ubuntu 24.04 or later. Detected: $PRETTY_NAME"
fi

log "Trafic Agent Installer"
log "TLD: $TLD"
echo ""

# Step 1: Install Node.js if needed
if ! command -v node &> /dev/null; then
  log "Installing Node.js 24..."
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
  success "Node.js $(node --version) installed"
else
  success "Node.js $(node --version) already installed"
fi

# Step 2: Install trafic-agent globally
log "Installing @studiometa/trafic-agent..."
npm install -g @studiometa/trafic-agent
success "trafic-agent installed"

# Step 3: Run setup
log "Running trafic-agent setup..."
echo ""
trafic-agent setup $SETUP_ARGS
