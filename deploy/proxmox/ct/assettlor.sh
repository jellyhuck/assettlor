#!/usr/bin/env bash
# Scripts root: install/assettlor-install.sh and /usr/bin/update resolve against
# this, and it is not derived from the URL this file was fetched from. Without
# it the engine looks in community-scripts/ProxmoxVE, which has no Assettlor.
_CS_DEFAULT_URL="https://raw.githubusercontent.com/jellyhuck/assettlor/main/deploy/proxmox"
# Engine pin. build.func reads _CS_CORE_DEFAULT_URL for every engine file it
# loads, so pinning only the bootstrap URL below would still load core@main.
_CS_CORE_DEFAULT_URL="https://raw.githubusercontent.com/community-scripts/core/d2281987365beaad7273fab29928f5f67a4e867c"
# /usr/bin/update exports the engine URL the container was built with. Drop an
# upstream commit pin so that bumping the pin here also moves old containers;
# a fork or branch URL is a deliberate override and is kept.
if [[ "${COMMUNITY_SCRIPTS_CORE_URL:-}" =~ ^https://raw\.githubusercontent\.com/community-scripts/core/[0-9a-f]{40}$ ]]; then
  unset COMMUNITY_SCRIPTS_CORE_URL
fi
if [[ -n "${COMMUNITY_SCRIPTS_CORE_DIR:-}" ]]; then
  source "${COMMUNITY_SCRIPTS_CORE_DIR}/core/build.func"
else
  source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL:-$_CS_CORE_DEFAULT_URL}/core/build.func")
fi

# Copyright (c) 2026 jellyhuck
# License: MIT | https://github.com/jellyhuck/assettlor/raw/main/LICENSE
# Source: https://github.com/jellyhuck/assettlor
# Engine: https://github.com/community-scripts/core

APP="Assettlor"
var_tags="${var_tags:-media;assets}"
var_cpu="${var_cpu:-2}"
var_ram="${var_ram:-2048}"
var_disk="${var_disk:-8}"
var_unprivileged="${var_unprivileged:-1}"

if [[ -z "${var_os:-}" ]] && command -v pveversion >/dev/null 2>&1; then
  var_os=$(msg_menu "Choose the container OS" \
    "debian" "Debian 13" \
    "alpine" "Alpine 3.24 (smaller)")
fi

var_os="${var_os:-debian}"
if [[ "${var_os}" == "alpine" ]]; then
  var_version="${var_version:-3.24}"
else
  var_version="${var_version:-13}"
fi

header_info "$APP"
variables
color
catch_errors

# Downloads RELEASE and builds it in /opt/assettlor.new, next to the running
# install, so a failed build leaves it in service. curl and tar rather than the
# engine's deploy helpers, which Alpine's helper library does not provide.
build_release() {
  msg_info "Building ${APP} ${RELEASE:0:7}"
  rm -rf /opt/assettlor.new
  local tmp
  tmp=$(mktemp -d /opt/.assettlor.XXXXXX)
  curl -fsSL "https://codeload.github.com/jellyhuck/assettlor/tar.gz/${RELEASE}" | tar -xzf - -C "$tmp"
  mv "$tmp"/assettlor-* /opt/assettlor.new
  rmdir "$tmp"
  cd /opt/assettlor.new
  $STD npm ci
  $STD npm prune --omit=dev
  rm -rf client/node_modules
  msg_ok "Built ${APP} ${RELEASE:0:7}"
}

# Swaps the build in while the service is stopped.
install_release() {
  msg_info "Updating ${APP} to ${RELEASE:0:7}"
  cd /opt
  rm -rf /opt/assettlor
  mv /opt/assettlor.new /opt/assettlor
  echo "${RELEASE}" >~/.assettlor
  msg_ok "Updated ${APP} to ${RELEASE:0:7}"
}

update_deb_based() {
  # Containers installed before python3 and make joined the dependencies lack them.
  msg_info "Installing Dependencies"
  $STD apt-get install -y python3 make
  msg_ok "Installed Dependencies"

  NODE_VERSION="24" setup_nodejs
  build_release

  msg_info "Stopping Service"
  systemctl stop assettlor
  msg_ok "Stopped Service"

  install_release

  msg_info "Starting Service"
  systemctl start assettlor
  msg_ok "Started Service"
}

update_alpine() {
  msg_info "Updating Alpine Packages"
  $STD apk -U upgrade
  $STD apk add --no-cache python3 make
  msg_ok "Updated Alpine Packages"

  build_release

  msg_info "Stopping Service"
  $STD rc-service assettlor stop
  msg_ok "Stopped Service"

  install_release

  msg_info "Starting Service"
  $STD rc-service assettlor start
  msg_ok "Started Service"
}

function update_script() {
  header_info
  check_container_storage
  check_container_resources

  if [[ ! -d /opt/assettlor ]]; then
    msg_error "No ${APP} Installation Found!"
    exit
  fi

  RELEASE=$(curl -fsSL -H "Accept: application/vnd.github.sha" https://api.github.com/repos/jellyhuck/assettlor/commits/main)
  if [[ "${RELEASE}" == "$(cat ~/.assettlor 2>/dev/null)" ]]; then
    msg_ok "No update required. ${APP} is already at ${RELEASE:0:7}"
    exit
  fi

  run_os_update
  msg_ok "Updated successfully!"
  exit
}

start
build_container
description

msg_ok "Completed Successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW}Access it using the following URL:${CL}"
echo -e "${GATEWAY}${BGN}http://${IP}:3001${CL}"
echo -e "${INFO}${YW}Mount asset folders into the container (e.g. pct set <CTID> -mp0 /tank/assets,mp=/mnt/assets),${CL}"
echo -e "${TAB}${YW}then add them as libraries in Settings.${CL}"
