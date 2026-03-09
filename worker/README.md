# chat-proxy

`ohshane.github.io/chat.html` → OpenRouter API 프록시 (Cloudflare Worker)

클라이언트에 API 키를 노출하지 않고 OpenRouter를 사용하기 위한 서버리스 프록시.

## 사전 준비

- [Cloudflare 계정](https://dash.cloudflare.com)
- [OpenRouter API 키](https://openrouter.ai/keys)
- Node.js 18+

## 배포

```bash
cd worker

# 1. Cloudflare 로그인
npx wrangler login

# 2. OpenRouter API 키 등록 (secret으로 저장되어 코드/대시보드에 노출 안 됨)
npx wrangler secret put OPENROUTER_API_KEY
# 프롬프트에 키 붙여넣기

# 3. 빌드 + 배포 (chat.html → public/index.html 복사 후 배포)
npm run deploy
```

배포 후 `https://chat-proxy.ohshane.workers.dev` 에서 동작.

## 로컬 개발

```bash
# .env 파일에 키 설정
vi .env

# chat.html 복사 + wrangler dev 실행
npm run dev

# http://localhost:8787 에서 chat.html + API 모두 동작
```

`chat.html`은 자동으로 환경을 감지하여:

- localhost / workers.dev → 같은 origin의 `/api/chat` 사용
- GitHub Pages → `https://chat-proxy.ohshane.workers.dev/api/chat` 사용

## API 키 업데이트

```bash
npx wrangler secret put OPENROUTER_API_KEY
# 새 키 붙여넣기 → 즉시 반영 (재배포 불필요)
```

## API 키 확인

Secret은 조회가 불가능함. 현재 등록된 secret 목록만 확인 가능:

```bash
npx wrangler secret list
```

## 모델 변경

모델은 `chat.html`의 `MODELS` 배열에서 관리. Worker 수정 불필요.

```js
const MODELS = [
  { id: "openai/gpt-4.1-nano", label: "GPT-4.1 Nano" },
  { id: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini" },
  // 여기에 추가/삭제
];
```

클라이언트가 모델을 선택하지 않으면 Worker에서 `openai/gpt-4.1-nano`를 기본값으로 사용.

## 삭제

```bash
# Worker 삭제 (되돌릴 수 없음)
npx wrangler delete
```

Cloudflare 대시보드에서도 삭제 가능:
Workers & Pages → chat-proxy → Settings → Delete

## 구조

```
worker/
├── package.json    # build/dev/deploy 스크립트
├── wrangler.toml   # Worker 설정, assets 설정
├── .gitignore      # public/, .env 제외
├── .env       # 로컬 개발용 API 키 (git 제외)
├── public/         # 빌드 시 chat.html이 복사되는 곳 (git 제외)
│   └── index.html
└── src/
    └── index.js    # POST /api/chat → OpenRouter 프록시
```
