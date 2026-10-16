#!/usr/bin/env bash

# Copyright (c) 2026 jellyhuck
# License: MIT | https://github.com/jellyhuck/assettlor/raw/main/LICENSE
# Source: https://github.com/jellyhuck/assettlor
# Engine: https://github.com/community-scripts/core

source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

# Shared by both OS paths. curl and tar rather than the engine's deploy helpers,
# which Alpine's helper library does not provide.
deploy_assettlor() {
  # There are no tagged releases, so a deploy is a commit of main.
  RELEASE=$(curl -fsSL -H "Accept: application/vnd.github.sha" https://api.github.com/repos/jellyhuck/assettlor/commits/main)

  msg_info "Building Assettlor ${RELEASE:0:7}"
  local tmp
  tmp=$(mktemp -d /opt/.assettlor.XXXXXX)
  curl -fsSL "https://codeload.github.com/jellyhuck/assettlor/tar.gz/${RELEASE}" | tar -xzf - -C "$tmp"
  mv "$tmp"/assettlor-* /opt/assettlor
  rmdir "$tmp"
  cd /opt/assettlor
  # The prepare script installs the client and builds it, which needs every
  # devDependency; prune afterwards rather than installing with --omit=dev.
  $STD npm ci
  $STD npm prune --omit=dev
  rm -rf client/node_modules
  echo "${RELEASE}" >~/.assettlor
  msg_ok "Built Assettlor ${RELEASE:0:7}"
}

configure_assettlor() {
  msg_info "Configuring Assettlor"
  # Kept outside /opt/assettlor, which every update replaces.
  mkdir -p /var/lib/assettlor/data /mnt/assets
  ASSETTLOR_CONF_DATA_DIR=/var/lib/assettlor/data ASSETTLOR_CONF_PORT=3001 \
    $STD node /opt/assettlor/bin/assettlor.js --generate-config /etc/assettlor/config.yaml
  # The bind address and Host allowlist have no generator variable. Listen on
  # every interface so the container's IP works, and accept its hostname too.
  # One-line replacements, so BusyBox sed on Alpine handles them as GNU sed does.
  sed -i \
    -e 's/^  host: 127\.0\.0\.1$/  host: 0.0.0.0/' \
    -e "s/^  allowed_hosts: \[\]$/  allowed_hosts: [ $(hostname) ]/" \
    /etc/assettlor/config.yaml
  grep -q '^  host: 0\.0\.0\.0$' /etc/assettlor/config.yaml || {
    msg_error "Could not set server.host in /etc/assettlor/config.yaml"
    exit 1
  }
  msg_ok "Configured Assettlor"
}

setup_deb_based() {
  # node-gyp needs Python and make to build better-sqlite3 when no prebuilt
  # binary matches.
  msg_info "Installing Python and make"
  $STD apt-get install -y python3 make
  msg_ok "Installed Python $(python3 --version | cut -d" " -f2) and make $(make --version | head -n1 | awk '{print $NF}')"

  NODE_VERSION="24" setup_nodejs
  deploy_assettlor
  configure_assettlor

  msg_info "Creating Service"
  cat <<EOF >/etc/systemd/system/assettlor.service
[Unit]
Description=Assettlor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/assettlor
ExecStart=/usr/bin/node /opt/assettlor/bin/assettlor.js --config /etc/assettlor/config.yaml
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl enable -q --now assettlor
  msg_ok "Created Service"
}

setup_alpine() {
  # Alpine's own nodejs package; the native modules ship musl builds. Python and
  # make are for node-gyp, should better-sqlite3 have no prebuilt binary.
  msg_info "Installing Node.js, Python and make"
  $STD apk add --no-cache nodejs npm python3 make
  msg_ok "Installed Node.js $(node --version), Python $(python3 --version | cut -d" " -f2) and make $(make --version | head -n1 | awk '{print $NF}')"

  deploy_assettlor
  configure_assettlor

  msg_info "Creating Service"
  cat <<'EOF' >/etc/init.d/assettlor
#!/sbin/openrc-run
name="Assettlor"
description="Local-first asset manager"

command="/usr/bin/node"
command_args="/opt/assettlor/bin/assettlor.js --config /etc/assettlor/config.yaml"
supervisor=supervise-daemon
directory="/opt/assettlor"
output_log="/var/log/assettlor.log"
error_log="/var/log/assettlor.log"
respawn_delay=5

depend() {
  need net
  after firewall
}

start_pre() {
  checkpath -f -m 0640 "$output_log"
}
EOF
  chmod +x /etc/init.d/assettlor
  $STD rc-update add assettlor default
  $STD rc-service assettlor start
  msg_ok "Created Service"
}

run_os_setup

motd_ssh
customize
cleanup_lxc
