# WekiFlow GCP 데모 배포 가이드

> 단일 GCE VM + Docker Compose 기반의 최소 비용 데모 배포 가이드입니다.
> 월 예상 비용: **~$18–20** (e2-medium, 서울 리전)

## 아키텍처

```
GCE VM (e2-medium)
├── nginx  :80      — React SPA 서빙 + /api 리버스 프록시
├── api    :3001    — Fastify API (낮부, nginx만 접근)
├── worker          — BullMQ 잡 프로세서
├── postgres:5432   — PostgreSQL 18
├── redis  :6379    — Redis 7 (AOF 영속성)
└── minio  :9000    — S3 호환 오브젝트 스토리지
```

모든 서비스는 `docker-compose.prod.yml` 하나로 관리됩니다.
CI/CD는 GitHub Actions → Artifact Registry → GCE SSH 배포 순으로 동작합니다.

---

## 파일 구조

```
docker/
  Dockerfile.api       — API 멀티스테이지 빌드 (node:24-alpine)
  Dockerfile.worker    — Worker 멀티스테이지 빌드
  Dockerfile.web       — Vite 빌드 → nginx 정적 서빙
  nginx.conf           — SPA fallback + /api 리버스 프록시 + 정적 캐싱
  DEPLOY.md            — 이 문서
docker-compose.prod.yml
.github/workflows/deploy.yml
deploy/setup-vm.sh
```

---

## Step 1 — GCP 리소스 생성

```bash
PROJECT_ID=wekiflow-demo
REGION=asia-northeast3    # 서울
ZONE=asia-northeast3-a

# Artifact Registry
gcloud artifacts repositories create wekiflow \
  --repository-format=docker \
  --location=$REGION \
  --project=$PROJECT_ID

# GCE VM
gcloud compute instances create wekiflow-demo \
  --project=$PROJECT_ID \
  --zone=$ZONE \
  --machine-type=e2-medium \
  --boot-disk-size=30GB \
  --boot-disk-type=pd-standard \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --tags=http-server \
  --scopes=https://www.googleapis.com/auth/logging.write,https://www.googleapis.com/auth/monitoring.write

# 방화벽 (80 포트)
gcloud compute firewall-rules create allow-http \
  --project=$PROJECT_ID \
  --allow=tcp:80 \
  --target-tags=http-server
```

> API(3001)는 외부에 직접 열지 않습니다. nginx가 `/api` 경로로 리버스 프록시합니다.

---

## Step 2 — VM 초기화 (1회)

```bash
# SSH 접속
gcloud compute ssh wekiflow-demo --zone=$ZONE

# VM 안에서 실행
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
sudo systemctl enable docker
newgrp docker

# gcloud 인증 (Artifact Registry)
gcloud auth configure-docker asia-northeast3-docker.pkg.dev --quiet

# 앱 디렉토리
sudo mkdir -p /opt/wekiflow && sudo chown $USER:$USER /opt/wekiflow
cd /opt/wekiflow
git clone https://github.com/YOUR_ORG/wekiflow.git .
```

또는 리포에 포함된 스크립트를 사용합니다:

```bash
bash deploy/setup-vm.sh
```

---

## Step 3 — GitHub Actions 설정

### Secrets

| 이름 | 설명 |
|---|---|
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Workload Identity 풀 리소스 이름 |
| `GCP_SERVICE_ACCOUNT` | 배포용 서비스 계정 이메일 |
| `GCE_SSH_PRIVATE_KEY` | VM SSH 접속용 개인키 |
| `POSTGRES_PASSWORD` | PostgreSQL 비밀번호 |
| `REDIS_PASSWORD` | Redis 비밀번호 |
| `MINIO_ROOT_PASSWORD` | MinIO 비밀번호 |
| `JWT_SECRET` | JWT 서명 키 (32자 이상) |
| `OPENAI_API_KEY` | OpenAI API 키 |
| `GEMINI_API_KEY` | Gemini API 키 (선택) |

### Variables

| 이름 | 예시 값 |
|---|---|
| `GCP_PROJECT_ID` | `wekiflow-demo` |
| `GCE_INSTANCE_NAME` | `wekiflow-demo` |
| `GCE_ZONE` | `asia-northeast3-a` |
| `VITE_API_URL` | `/api` (Dockerfile 빌드 시 하드코딩됨, Variables에서 생략 가능) |

> **GitHub Environment 미리 생성 필요**: 리포지토리 Settings > Environments에 `production` 환경을 미리 만들어두지 않으면 배포가 pending 상태에서 멈출 수 있습니다. (현재 `deploy.yml`에서는 `environment: production`을 제거했으므로 필수는 아니나, Environments를 사용하려면 반드시 사전 생성이 필요합니다.)
>
> **Workload Identity 대신 SA Key를 쓰는 더 간단한 방법**: `secrets.GCP_SA_KEY`에 서비스 계정 JSON 키를 저장하고, `deploy.yml`의 auth step을 아래처럼 교체합니다.
>
> ```yaml
> - uses: google-github-actions/auth@v2
>   with:
>     credentials_json: ${{ secrets.GCP_SA_KEY }}
> ```

---

## Step 4 — 배포

```bash
# main 푸시 시 자동 트리거
git push origin main
```

또는 GitHub Actions 탭 → "Build & Deploy" → "Run workflow" 로 수동 실행.

파이프라인 흐름:

```
push to main
  → Build & push 3개 이미지 (api, worker, web) → Artifact Registry
  → SSH into GCE VM
    → git pull
    → docker compose pull
    → docker compose up -d --remove-orphans
    → docker image prune -f
```

---

## DB 마이그레이션

`docker-compose.prod.yml`에 `migrate` 서비스가 포함돼 있습니다.
배포 시 migrate 컨테이너가 먼저 실행되어 `packages/db/dist/migrate.js`를 통해 마이그레이션을 수행한 뒤, api와 worker가 시작됩니다.

API 패키지에 해당 진입점이 없다면 아래처럼 추가하세요:

```ts
// packages/db/src/migrate.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);
await migrate(drizzle(sql), { migrationsFolder: 'src/migrations' });
await sql.end();
```

---

## 운영 명령어

```bash
# VM에서 실행
cd /opt/wekiflow

# 로그 확인
docker compose -f docker-compose.prod.yml logs -f api
docker compose -f docker-compose.prod.yml logs -f worker

# 서비스 상태 (healthcheck 포함)
docker compose -f docker-compose.prod.yml ps
docker inspect --format='{{.State.Health.Status}}' $(docker compose -f docker-compose.prod.yml ps -q api)

# 재시작
docker compose -f docker-compose.prod.yml restart api

# 수동 이미지 교체 (긴급 패치)
# ⚠️ schema 변경이 포함된 배포라면 반드시 migrate도 함께 실행하세요:
#   IMAGE_TAG=abc123 docker compose -f docker-compose.prod.yml --env-file .env.prod up -d migrate api worker
IMAGE_TAG=abc123 docker compose -f docker-compose.prod.yml --env-file .env.prod up -d api
```

---

## 월 예상 비용 (서울 리전)

| 항목 | 사양 | 월 비용 |
|---|---|---|
| GCE e2-medium | 2vCPU / 4GB RAM | ~$15 |
| 영구 디스크 | 30GB pd-standard | ~$1.5 |
| Artifact Registry | 이미지 저장 ~5GB | ~$0.5 |
| 네트워크 egress | 데모 수준 | ~$1 |
| **합계** | | **~$18–20/월** |

> VM을 중지(stop)하면 디스크 비용만 ~$1.5/월로 절약할 수 있습니다.
> `gcloud compute instances stop wekiflow-demo --zone=$ZONE`

---

## 보안 참고사항 (전시회 필수)

현재 데모는 HTTP 80포트만 열고 있습니다. 전시회 등 공용 Wi-Fi 환경에서는 JWT 토큰이 평문으로 전송되어 **중간자 공격 위험**이 있습니다. 데모 전 반드시 아래 중 하나를 적용하세요:

1. **Cloudflare Flexible SSL** (가장 빠름): DNS를 Cloudflare로 연결하고 SSL/TLS 모드를 Flexible로 설정. 5분 내 적용 가능.
2. **Let's Encrypt + Certbot**: 도메인이 있다면 VM에서 certbot으로 묶인 인증서를 발급받고 nginx가 443을 수신하도록 설정.

---

## 향후 확장 경로

데모를 넘어 실서비스로 전환할 때 고려할 사항:

- **MinIO → GCS**: `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` 환경변수만 교체 (AWS SDK 호환)
- **단일 VM → Cloud Run**: API / Worker를 Cloud Run으로 분리, 트래픽 기반 autoscaling
- **postgres → Cloud SQL**: 자동 백업, 고가용성 확보
- **redis → Memorystore**: 관리형 Redis (월 ~$16부터)
- **nginx → Cloud Load Balancing + CDN**: HTTPS 자동화, 글로벌 캐싱
