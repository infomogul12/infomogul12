// 관리자 계정을 만드는 SQL을 출력한다. 비밀번호는 이 컴퓨터 안에서만 처리되고 어디에도 전송되지 않는다.
// 사용법:  node scripts/make-admin.mjs 아이디 chair|desk
//         (비밀번호를 물어보면 입력. 입력한 글자가 화면에 보이니 주변을 확인하세요.)
import { createInterface } from 'node:readline/promises';
import { hashPassword } from '../src/logic.js';

const [, , username, role] = process.argv;
if (!username || !['chair', 'desk'].includes(role)) {
  console.error('사용법: node scripts/make-admin.mjs 아이디 chair|desk   (chair: 선거관리위원장, desk: 접수 담당)');
  process.exit(1);
}
if (!/^[A-Za-z0-9_.-]{2,32}$/.test(username)) { console.error('아이디는 영문·숫자·_.- 2~32자로 하세요.'); process.exit(1); }
const rl = createInterface({ input: process.stdin, output: process.stderr });
const pw = process.env.ADMIN_PASSWORD || (await rl.question('비밀번호(12자 이상): '));
rl.close();
if (pw.length < 12 || new TextEncoder().encode(pw).length > 200) { console.error('비밀번호는 12자 이상이어야 합니다.'); process.exit(1); }
const hash = await hashPassword(pw);
console.log(`INSERT INTO admin_user (username, password_hash, role) VALUES ('${username}', '${hash}', '${role}');`);
console.error('\n위 SQL을 Cloudflare 대시보드의 D1 > church-vote > Console에 붙여 넣어 실행하세요.');
