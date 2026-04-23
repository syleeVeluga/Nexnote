#!/usr/bin/env bash
# GCE VM 초기 세팅 스크립트 (VM에 SSH 접속 후 1회 실행)
set -euo pipefail

# ── 1. Docker 설치 ────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"
  echo "Docker installed. Re-login or run: newgrp docker"
fi

# ── 2. Docker Compose Plugin ──────────────────────────────────────────────────
if ! docker compose version &>/dev/null; then
  sudo apt-get install -y docker-compose-plugin
fi

# ── 3. gcloud CLI (이미 GCE VM에는 설치돼 있음, 필요 시 활성화) ───────────────
gcloud auth configure-docker asia-northeast3-docker.pkg.dev --quiet

# ── 4. 앱 디렉토리 세팅 ──────────────────────────────────────────────────────
sudo mkdir -p /opt/nexnote
sudo chown "$USER":"$USER" /opt/nexnote
cd /opt/nexnote

# ── 5. 리포 클론 (docker-compose.prod.yml 가져오기 위해) ─────────────────────
if [ ! -d ".git" ]; then
  git clone https://github.com/YOUR_ORG/nexnote.git .
fi

# ── 6. 방화벽 확인 안내 ───────────────────────────────────────────────────────
echo ""
echo "========================================================"
echo "GCP 콘솔에서 아래 방화벽 규칙을 확인하세요:"
echo "  - TCP 80   (web)"
echo "  - TCP 3001 (api, 내부 LB 사용 시 제거 가능)"
echo "  - TCP 22   (SSH, IAP 터널 사용 시 제거 가능)"
echo "========================================================"
echo "설정 완료. .env.prod 파일을 직접 생성하거나"
echo "GitHub Actions 배포를 트리거하세요."
