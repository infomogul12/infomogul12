# 교회 선출투표 (Cloudflare Worker + D1)

교적부(엑셀/CSV) 업로드 → 선거인명부 확정 → 현장 QR 발급(또는 오프라인 투표 확인) → 스마트폰 가/부 일괄 투표 → 온라인·오프라인 합산 개표.
서버는 Cloudflare Worker, 데이터는 Cloudflare D1에 저장됩니다. 별도 서버 관리가 필요 없습니다.

## 1. 처음 한 번만 하는 설정

1. **코드 올리기**: 이 폴더를 GitHub 저장소에 올립니다.
2. **Cloudflare에 연결**: 대시보드 → Workers & Pages → Create → *Import a repository* → 이 저장소 선택.
   배포 명령은 `npx wrangler deploy` (기본값). `wrangler.toml`에 D1(`church-vote`) 연결이 이미 들어 있습니다.
3. **비밀 값 등록**: Worker → Settings → Variables and Secrets → *Secret* 추가
   - 이름 `VOTE_PEPPER`, 값은 무작위 문자 40자 이상 (예: 비밀번호 생성기). **한 번 정하면 바꾸지 마세요.** 바꾸면 발급된 QR이 모두 무효가 됩니다.
4. **관리자 계정 만들기** (내 컴퓨터에서, Node.js 설치 필요)
   ```
   node scripts/make-admin.mjs kim chair     # 선거관리위원장
   node scripts/make-admin.mjs desk1 desk    # 접수 담당
   ```
   출력된 SQL을 Cloudflare 대시보드 → D1 → church-vote → Console 에 붙여 넣어 실행합니다.
5. Worker 주소(예: `https://church-vote.<계정>.workers.dev`)의 `/admin` 으로 접속해 로그인합니다.
   QR에 들어가는 주소는 접속한 주소가 자동으로 쓰입니다.

데이터베이스 표(스키마)는 이미 만들어져 있습니다(`migrations/0001_init.sql`).

## 2. 투표 진행

접수 화면에서 본인 확인 후 **QR 발급** 또는 **오프라인 투표**를 누릅니다. 오프라인으로 바꾸면 이미 발급된 QR은 무효가 됩니다.
투표 종료 후 개표 화면에서 종이 투표 합계를 입력하면 온라인과 합산됩니다. 결과에는 합산값만 표시됩니다(온라인/오프라인 구분 없음).
가결 기준의 분모 = 온라인 투표자 + 오프라인 유효 투표지 수.

## 3. 무료 플랜 주의

- Worker 무료 플랜은 요청당 CPU 시간이 짧습니다(약 10ms). 로그인의 비밀번호 검증과 큰 엑셀 파일 읽기가 이 한도에 걸리면 오류(1102)가 날 수 있습니다.
  투표 전에 **모의 선거로 로그인과 교적부 불러오기를 꼭 시험**하세요. 문제가 되면 Workers Paid 플랜(월 5달러)으로 올리면 해결됩니다.
- 무료 한도: 하루 요청 10만 건, D1 저장 5GB. 교회 선거 규모에서는 충분합니다.
- D1은 만료되지 않습니다. 투표 전후에 백업하세요: `npx wrangler d1 export church-vote --remote --output backup.sql`

## 4. 개인정보와 비밀투표

- 투표 기록(`ballot`)에는 유권자와 연결되는 열이 없습니다. QR(누가)과 투표함(무엇을)은 서로 참조하지 않고, 사용 시각은 '시' 단위로만 남깁니다.
- QR 원문은 저장하지 않고 `VOTE_PEPPER`로 만든 해시만 저장합니다.
- 선거가 끝나면 교적부(생년월일 포함)를 파기하거나 접근을 제한하세요.

## 5. 시험

```
npm test        # Node 22 이상. D1과 같은 모양의 시험용 도구로 전체 흐름을 검사합니다.
```
