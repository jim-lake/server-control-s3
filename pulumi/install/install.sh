#!/bin/bash

set -e

APP_NAME="server-control-s3-example"
LOAD_HASH="27d81f76c5fd1e085450b621afc1bceb315921e7"
CODE_URL="s3://server-control-s3-example/example-app/$LOAD_HASH.tar.gz"
NODE_COMMAND="node server.js"
HOSTNAME=$APP_NAME
NODE_PORT=3000
NGINX_PORT=80
NODE_VER=20
NODE_USER=node
NODE_HOME="/var/$NODE_USER"
REPO_DIR="$NODE_HOME/$APP_NAME"
NODE_ENV="PWD=$REPO_DIR,NODE_ENV=production,NODE_CONFIG_SET=prod,PORT=$NODE_PORT"
CODE_HOME_DIR="$NODE_HOME/$LOAD_HASH-install"
VERBOSE_LOG=/tmp/install.log

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

function template() {
  eval "cat <<EOF
$(<$1)
EOF
" 2> /dev/null > $2
}

echo "-- Remove snaps because they suck"
if [ -e /usr/bin/snap ] ; then
  snap remove amazon-ssm-agent
  snap remove core22
  snap remove snapd
fi



echo "-- Setup node user"
rm -rf $NODE_HOME
if id "$NODE_USER" &>/dev/null; then
  deluser $NODE_USER >$VERBOSE_LOG
fi
adduser $NODE_USER --home $NODE_HOME --disabled-password --gecos '' >$VERBOSE_LOG

echo "-- Add nodesource repo"
DEBIAN_FRONTEND=noninteractive apt-get install -qq gpg >>$VERBOSE_LOG
rm -f /usr/share/keyrings/nodesource.gpg
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_VER}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list


echo "-- apt update"
DEBIAN_FRONTEND=noninteractive apt-get update >>$VERBOSE_LOG

echo "-- Remove apt crap"
DEBIAN_FRONTEND=noninteractive apt-get remove -qq apparmor accountsservice multipath-tools udisks2 policykit-1 unattended-upgrades modemmanager gpg-agent polkitd fwupd rsyslog >>$VERBOSE_LOG

echo "-- apt Clean"
DEBIAN_FRONTEND=noninteractive apt-get autoremove -qq >>$VERBOSE_LOG
DEBIAN_FRONTEND=noninteractive apt-get clean -qq >>$VERBOSE_LOG

echo "-- apt upgrade"
DEBIAN_FRONTEND=noninteractive apt-get upgrade -qq >>$VERBOSE_LOG

echo "-- Set hostname and persist it"
hostname $HOSTNAME
echo $HOSTNAME > /etc/hostname
cp "$SCRIPT_DIR/80_hostnames.cfg" /etc/cloud/cloud.cfg.d/80_hostnames.cfg
sed -i "/^127.0.0.1 $HOSTNAME/d" /etc/hosts
echo "127.0.0.1 $HOSTNAME" >> /etc/hosts


# ------- non boilerplate -------------------------------


echo "-- Add good stuff"
DEBIAN_FRONTEND=noninteractive apt-get install -qq build-essential tmpreaper supervisor python3-pip nginx >>$VERBOSE_LOG
echo "-- Add nodejs"
DEBIAN_FRONTEND=noninteractive apt-get install -qq nodejs >>$VERBOSE_LOG
echo "-- Add aws-cli"
pip3 install awscli --break-system-packages >>$VERBOSE_LOG


echo "-- setup tmpreaper"
sed -i 's/^SHOWWARNING=true/# SHOWWARNING=true/' /etc/tmpreaper.conf

echo "-- Setup swap"
swapoff -a
rm -rf /swapfile
fallocate -l 1G /swapfile
chmod 600 /swapfile
mkswap /swapfile >>$VERBOSE_LOG
swapon /swapfile
echo "vm.swappiness = 10" > /etc/sysctl.d/99-swap.conf
sysctl -q --system
sed -i "/^\/swapfile/d" /etc/fstab
echo '/swapfile none swap sw 0 0' >> /etc/fstab

echo "-- Setup node repo"
rm -rf "$CODE_HOME_DIR"
sudo -u $NODE_USER mkdir "$CODE_HOME_DIR"
if [[ $CODE_URL == http* ]] ; then
  sudo -u $NODE_USER wget "$CODE_URL" -O "$CODE_HOME_DIR/output.tar.gz"
else
  sudo -u $NODE_USER aws s3 cp "$CODE_URL" "$CODE_HOME_DIR/output.tar.gz"
fi
sudo -u $NODE_USER bash -c "cd \"$CODE_HOME_DIR\" && tar xzf output.tar.gz"
rm "$CODE_HOME_DIR/output.tar.gz"
sudo -u $NODE_USER ln -s "$CODE_HOME_DIR" "$REPO_DIR"

echo "-- Run npm ci, this might take a while"
sudo -u $NODE_USER bash -c "cd \"$CODE_HOME_DIR\" && NO_UPDATE_NOTIFIER=1 npm ci --silent --progress false"

echo "-- Setup instance update on first launch"
echo '#!/bin/bash' >/var/lib/cloud/scripts/per-instance/instance_update.sh
echo "" >>/var/lib/cloud/scripts/per-instance/instance_update.sh
echo "\"$REPO_DIR/node_modules/server-control-s3/scripts/instance_update.sh\"" >>/var/lib/cloud/scripts/per-instance/instance_update.sh
echo "" >>/var/lib/cloud/scripts/per-instance/instance_update.sh
chmod +x /var/lib/cloud/scripts/per-instance/instance_update.sh

echo "-- Setup supervisor"
mkdir -p "/etc/systemd/system/supervisor.service.d/"
cp "$SCRIPT_DIR/supervisor_override.conf" /etc/systemd/system/supervisor.service.d/override.conf
template "$SCRIPT_DIR/app_supervise.conf.env" "/etc/supervisor/conf.d/$APP_NAME.conf"

echo "-- Setup nginx"
template "$SCRIPT_DIR/node_nginx.conf.env" "/etc/nginx/sites-available/$APP_NAME.conf"
rm -f /etc/nginx/sites-enabled/default
ln -sf "/etc/nginx/sites-available/$APP_NAME.conf" "/etc/nginx/sites-enabled/$APP_NAME.conf"


# ------- end non boilerplate -------------------------------


echo "-- Get rid of systemd-hostnamed"
systemctl mask systemd-hostnamed.service

echo "-- Get rid of systemd-resolved"
systemctl disable systemd-resolved.service
systemctl stop systemd-resolved.service
rm -f /etc/resolv.conf

echo "-- Setup static resolv.conf because it works like that"
echo "nameserver 169.254.169.253" > /etc/resolv.conf
IP=$(ip route get 8.8.8.8 | head -1 | cut -d' ' -f 3)
echo "nameserver ${IP/1.1/0.2}" >> /etc/resolv.conf
echo "nameserver 8.8.8.8" >> /etc/resolv.conf
echo "nameserver 8.8.4.4" >> /etc/resolv.conf

echo "-- Remove systemd resolved crap"
DEBIAN_FRONTEND=noninteractive apt-get remove -qq systemd-resolved >>$VERBOSE_LOG

echo "-- done done"
